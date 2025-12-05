/**
 * Port Handle Adapter - Unified handle interface for ports
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * PortHandleAdapter wraps Port objects (listeners, watchers, pubsub) in the
 * kernel's unified handle interface. Ports represent resources that receive
 * messages from multiple sources - TCP listeners accepting connections, file
 * system watchers emitting events, or pubsub subscriptions receiving broadcasts.
 *
 * Unlike channels (bidirectional streams), ports are primarily receive-oriented
 * with optional send capabilities. The adapter translates handle operations
 * into port operations:
 * - recv: Block until next message/event arrives
 * - send: Send message to destination (pubsub, UDP)
 * - stat: Query port metadata (type, description)
 *
 * For TCP listen ports, recv() returns socket information. The kernel must then
 * create a new channel handle wrapping the accepted socket. This two-step
 * process separates accept logic (port) from connection handling (channel).
 *
 * Ports are long-lived resources that may outlive their creator. The kernel
 * tracks port ownership and automatically closes ports when the owner terminates.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: type is always 'port' for this handle implementation
 * INV-2: Once _closed is true, exec() yields EBADF and close() is idempotent
 * INV-3: closed getter reflects both adapter state and underlying port state
 * INV-4: id is immutable and unique across all handles
 * INV-5: port reference remains valid until close() completes
 * INV-6: All exec() generators must yield at least one Response before returning
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Port
 * operations are designed to be safe under concurrent access:
 *
 * Multiple callers can invoke recv() concurrently. The underlying port
 * implementation queues incoming messages and distributes them FIFO to waiting
 * receivers. Each recv() call consumes exactly one message.
 *
 * send() operations are independent and can be concurrent. The port
 * implementation handles queuing and delivery ordering.
 *
 * close() sets _closed before calling port.close(), preventing new operations
 * from starting. In-flight recv() calls will be interrupted with an error
 * response when the port closes.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed at start of exec() before delegating to port
 * RC-2: Closure check is fail-fast - yields error without awaiting port
 * RC-3: close() sets _closed before calling port.close() to prevent new ops
 * RC-4: Idempotent close() prevents double-close of underlying port
 * RC-5: closed getter checks both adapter and port for consistency
 * RC-6: recv() error handling catches port closure during wait
 *
 * MEMORY MANAGEMENT
 * =================
 * - Adapter holds a reference to the underlying port until close()
 * - Messages are yielded to callers (not buffered in adapter)
 * - Ports may buffer incoming messages internally (implementation-specific)
 * - recv() operations hold no resources after yielding message
 * - Callers should use try/finally or `await using` to ensure cleanup
 *
 * @module kernel/handle/port
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Port } from '@src/kernel/resource.js';
import type { Handle, HandleType } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Port handle wrapping Port (listeners, watchers, pubsub).
 *
 * Ports provide recv/send operations for message-oriented resources.
 * The adapter translates handle exec() calls into port operations.
 */
export class PortHandleAdapter implements Handle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Handle type identifier.
     *
     * WHY: Discriminant for Handle union type, enables type-safe casting.
     * INVARIANT: Always 'port' for this implementation.
     */
    readonly type: HandleType = 'port';

    /**
     * Unique handle identifier.
     *
     * WHY: Kernel uses this for handle table lookups and access control.
     * INVARIANT: Immutable, unique across all handles in the system.
     */
    readonly id: string;

    /**
     * Human-readable description of the port.
     *
     * WHY: Debugging and logging - identifies port purpose.
     * Examples: 'tcp:listen:8080', 'fs:watch:/data', 'pubsub:topic:events'
     * INVARIANT: Immutable after construction.
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether this adapter has been closed.
     *
     * WHY: Prevents operations on closed handles even if port is still open.
     * INVARIANT: Once true, never becomes false. Set before port.close().
     */
    private _closed = false;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Underlying port.
     *
     * WHY: Delegate for all port operations. Private to enforce access
     * through handle interface.
     * INVARIANT: Non-null until close() completes.
     */
    private port: Port;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new port handle adapter.
     *
     * @param id - Unique handle identifier (from kernel)
     * @param port - Underlying port to wrap
     * @param description - Human-readable port description
     */
    constructor(id: string, port: Port, description: string) {
        this.id = id;
        this.port = port;
        this.description = description;
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Whether handle is closed.
     *
     * WHY: Checks both adapter and port state for consistency.
     * RACE CONDITION: Port may close independently (error/resource cleanup).
     * We must reflect that state even if we haven't called close().
     *
     * @returns true if either adapter or port is closed
     */
    get closed(): boolean {
        return this._closed || this.port.closed;
    }

    // =========================================================================
    // HANDLE OPERATIONS
    // =========================================================================

    /**
     * Execute an operation on this handle.
     *
     * ALGORITHM:
     * 1. Check closure state (fail-fast with EBADF)
     * 2. Extract operation and data from message
     * 3. Dispatch to operation handler based on op field
     * 4. Yield responses from operation handler
     *
     * Supported operations:
     * - recv: Receive next message (blocks until available)
     * - send: Send message to destination (pubsub, UDP)
     * - stat: Get port info (type, description)
     *
     * RACE CONDITION:
     * Closure can occur during recv(). Port will reject pending recv()
     * calls with an error. We catch and translate this to EBADF.
     *
     * @param msg - Message containing operation and data
     * @yields Response(s) from the operation
     */
    async *exec(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check closure before starting operation
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');

            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'recv':
                // WHY: Receive operations block until message available.
                // Yields error if port closes during wait.
                yield* this.recv();
                break;

            case 'send':
                // WHY: Send message to destination (pubsub topic, UDP address).
                // Validates 'to' field, data/meta are optional depending on port type.
                yield* this.portSend(
                    data?.to as string,
                    data?.data as Uint8Array | undefined,
                    data?.meta as Record<string, unknown> | undefined,
                );
                break;

            case 'stat':
                // WHY: Query port metadata for debugging and capability checks.
                yield respond.ok({
                    type: this.port.type,
                    description: this.description,
                });
                break;

            default:
                // WHY: Reject unknown operations - ports have fixed operation set.
                // Unlike channels, we don't forward to port (no generic handler).
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    // =========================================================================
    // OPERATION HANDLERS
    // =========================================================================

    /**
     * Receive next message from port.
     *
     * ALGORITHM:
     * 1. Await port.recv() (blocks until message available)
     * 2. Yield message as 'item' response
     * 3. Handle errors (port closed, timeout, etc.)
     *
     * For TCP listen ports, message contains socket info.
     * For watch ports, message contains filesystem event.
     * For pubsub ports, message contains published data.
     *
     * RACE CONDITION:
     * Port may close while recv() is waiting. Port implementation will
     * reject the promise with an error. We catch and translate to EIO.
     *
     * @yields Single 'item' response with message, or 'error' response
     */
    private async *recv(): AsyncIterable<Response> {
        try {
            const msg = await this.port.recv();

            yield respond.item(msg);
        }
        catch (err) {
            // RACE FIX: Port closed during recv() - translate to EIO
            yield respond.error('EIO', (err as Error).message);
        }
    }

    /**
     * Send message to destination.
     *
     * ALGORITHM:
     * 1. Validate 'to' parameter (required, must be string)
     * 2. Call port.send() with destination, data, and metadata
     * 3. Yield ok on success, error on failure
     *
     * WHY data is optional:
     * Some send operations carry metadata only (pubsub subscribe, watch start).
     * UDP send requires data. Port implementation validates per-type.
     *
     * @param to - Destination identifier (topic, address, path)
     * @param data - Optional message payload
     * @param meta - Optional message metadata
     * @yields Single 'ok' or 'error' response
     */
    private async *portSend(
        to: string,
        data?: Uint8Array,
        meta?: Record<string, unknown>,
    ): AsyncIterable<Response> {
        if (typeof to !== 'string') {
            yield respond.error('EINVAL', 'to must be a string');

            return;
        }

        try {
            await this.port.send(to, data, meta);
            yield respond.ok();
        }
        catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close the handle and underlying port.
     *
     * ALGORITHM:
     * 1. Check if already closed (idempotent)
     * 2. Set _closed flag (prevents new operations)
     * 3. Close underlying port (releases resources)
     *
     * WHY _closed is set first:
     * Prevents race where new operations start during port.close().
     * In-flight recv() operations will be interrupted by port closure.
     *
     * Safe to call multiple times - subsequent calls are no-ops.
     */
    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        // RACE FIX: Set closed flag before calling port.close()
        // to prevent new operations from starting
        this._closed = true;

        await this.port.close();
    }

    // =========================================================================
    // KERNEL-INTERNAL ACCESSORS (for special operations)
    // =========================================================================

    /**
     * Get underlying port.
     *
     * WHY: Some kernel operations need direct port access (e.g., socket
     * allocation on tcp:listen accept). This bypasses the handle abstraction
     * for privileged kernel code only.
     *
     * SAFETY: Caller must not store port reference beyond handle lifetime.
     * Caller must check port type before casting to specific port implementation.
     *
     * @returns Underlying port object
     */
    getPort(): Port {
        return this.port;
    }

    /**
     * Get port type.
     *
     * WHY: Type-based dispatch for kernel operations that handle different
     * port types (tcp:listen vs fs:watch vs pubsub:subscribe).
     *
     * @returns Port type identifier (e.g., 'tcp:listen', 'fs:watch', 'pubsub:subscribe')
     */
    getPortType(): string {
        return this.port.type;
    }
}
