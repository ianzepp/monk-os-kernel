/**
 * Channel Handle Adapter - Unified handle interface for HAL channels
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ChannelHandleAdapter wraps HAL Channel objects in the kernel's unified handle
 * interface. Channels represent bidirectional message streams between processes,
 * kernel services, or external systems. This adapter translates handle operations
 * (exec/close) into channel operations (handle/push/recv/close).
 *
 * Channels are message-oriented rather than byte-oriented. Each channel has a
 * protocol (proto) that defines the message format and semantics. The adapter
 * supports multiple operation types:
 * - call: Request-response pattern (single response)
 * - stream: Request-stream pattern (multiple responses)
 * - push: Server-side response injection
 * - recv: Bidirectional message reception
 *
 * This design separates handle lifecycle management (kernel concern) from
 * protocol implementation (channel concern). The kernel tracks handles and
 * enforces access control, while channels handle protocol-specific logic.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: type is always 'channel' for this handle implementation
 * INV-2: Once _closed is true, exec() yields EBADF and close() is idempotent
 * INV-3: closed getter reflects both adapter state and underlying channel state
 * INV-4: id is immutable and unique across all handles
 * INV-5: channel reference remains valid until close() completes
 * INV-6: All exec() generators must yield at least one Response before returning
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. The adapter
 * is designed to be safe under concurrent access patterns:
 *
 * Multiple callers can invoke exec() concurrently - each gets an independent
 * async generator that manages its own operation. The underlying channel must
 * handle concurrent operations safely (typically via queuing).
 *
 * The _closed flag prevents new operations from starting after close() is called,
 * but does not abort in-flight operations. Callers must handle closure during
 * stream operations by checking responses for EBADF errors.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed at start of exec() before delegating to channel
 * RC-2: Closure check is fail-fast - yields error without awaiting channel
 * RC-3: close() sets _closed before calling channel.close() to prevent new ops
 * RC-4: Idempotent close() prevents double-close of underlying channel
 * RC-5: closed getter checks both adapter and channel for consistency
 *
 * MEMORY MANAGEMENT
 * =================
 * - Adapter holds a reference to the underlying channel until close()
 * - Messages and responses are yielded to callers (not buffered in adapter)
 * - Caller is responsible for consuming async generators to completion
 * - Uncompleted generators may hold channel resources until GC
 * - Callers should use try/finally or `await using` to ensure cleanup
 *
 * @module kernel/handle/channel
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel } from '@src/hal/channel.js';
import type { Handle, HandleType } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Channel handle wrapping HAL Channel.
 *
 * Channels already have handle(msg) → AsyncIterable<Response>, so this
 * adapter is thin - it delegates to the channel and adds closure tracking.
 */
export class ChannelHandleAdapter implements Handle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Handle type identifier.
     *
     * WHY: Discriminant for Handle union type, enables type-safe casting.
     * INVARIANT: Always 'channel' for this implementation.
     */
    readonly type: HandleType = 'channel';

    /**
     * Unique handle identifier.
     *
     * WHY: Kernel uses this for handle table lookups and access control.
     * INVARIANT: Immutable, unique across all handles in the system.
     */
    readonly id: string;

    /**
     * Human-readable description of the channel.
     *
     * WHY: Debugging and logging - identifies channel purpose.
     * INVARIANT: Immutable after construction.
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether this adapter has been closed.
     *
     * WHY: Prevents operations on closed handles even if channel is still open.
     * INVARIANT: Once true, never becomes false. Set before channel.close().
     */
    private _closed = false;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Underlying HAL channel.
     *
     * WHY: Delegate for all message operations. Private to enforce access
     * through handle interface.
     * INVARIANT: Non-null until close() completes.
     */
    private channel: Channel;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new channel handle adapter.
     *
     * @param id - Unique handle identifier (from kernel)
     * @param channel - Underlying HAL channel to wrap
     * @param description - Human-readable channel description
     */
    constructor(id: string, channel: Channel, description: string) {
        this.id = id;
        this.channel = channel;
        this.description = description;
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Whether handle is closed.
     *
     * WHY: Checks both adapter and channel state for consistency.
     * RACE CONDITION: Channel may close independently (error/remote close).
     * We must reflect that state even if we haven't called close().
     *
     * @returns true if either adapter or channel is closed
     */
    get closed(): boolean {
        return this._closed || this.channel.closed;
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
     * 4. Yield responses from channel or operation handler
     *
     * Supported operations:
     * - call: Send message, receive single response (terminates on ok/error/done)
     * - stream: Send message, receive all responses (channel controls termination)
     * - push: Push response to channel (server-side)
     * - recv: Receive next message from channel (bidirectional)
     * - *: Forward unknown ops directly to channel
     *
     * RACE CONDITION:
     * Closure can occur during stream operations. Channel will handle this
     * by terminating the stream with an error response. We don't abort
     * in-flight generators - they complete naturally.
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
            case 'call':
                // WHY: Request-response pattern requires exactly one terminal response.
                // We iterate until we get ok/error/done, then stop.
                // INVARIANT: Channel must yield at least one response (enforced by channel impl).
                for await (const response of this.channel.handle(data?.msg as Message)) {
                    yield response;
                    if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
                        return;
                    }
                }
                // Channel closed without terminal response - protocol violation
                yield respond.error('EIO', 'No response from channel');
                break;

            case 'stream':
                // WHY: Stream pattern allows multiple responses. Channel controls termination.
                // We yield all responses until channel closes the stream.
                yield* this.channel.handle(data?.msg as Message);
                break;

            case 'push':
                // WHY: Server-side response injection for bidirectional channels.
                // Used by servers to push data to clients outside request/response.
                try {
                    await this.channel.push(data?.response as Response);
                    yield respond.ok();
                } catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }
                break;

            case 'recv':
                // WHY: Bidirectional message reception. Blocks until message available.
                // Used by servers to receive client requests on listen channels.
                try {
                    const recvMsg = await this.channel.recv();
                    yield respond.item(recvMsg);
                } catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }
                break;

            default:
                // WHY: Forward unknown ops to channel for protocol-specific handling.
                // This enables protocol extensions without modifying the adapter.
                yield* this.channel.handle(msg);
        }
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close the handle and underlying channel.
     *
     * ALGORITHM:
     * 1. Check if already closed (idempotent)
     * 2. Set _closed flag (prevents new operations)
     * 3. Close underlying channel (releases resources)
     *
     * WHY _closed is set first:
     * Prevents race where new operations start during channel.close().
     * In-flight operations complete naturally (channel handles cleanup).
     *
     * Safe to call multiple times - subsequent calls are no-ops.
     */
    async close(): Promise<void> {
        if (this._closed) return;

        // RACE FIX: Set closed flag before calling channel.close()
        // to prevent new operations from starting
        this._closed = true;

        await this.channel.close();
    }

    // =========================================================================
    // KERNEL-INTERNAL ACCESSORS (for special operations)
    // =========================================================================

    /**
     * Get underlying channel.
     *
     * WHY: Some kernel operations need direct channel access (e.g., socket
     * allocation, port binding). This bypasses the handle abstraction for
     * privileged kernel code only.
     *
     * SAFETY: Caller must not store channel reference beyond handle lifetime.
     *
     * @returns Underlying channel object
     */
    getChannel(): Channel {
        return this.channel;
    }

    /**
     * Get channel protocol.
     *
     * WHY: Protocol routing and capability checks need to know channel type.
     *
     * @returns Protocol identifier (e.g., 'http', 'ws', 'ipc')
     */
    getProto(): string {
        return this.channel.proto;
    }
}
