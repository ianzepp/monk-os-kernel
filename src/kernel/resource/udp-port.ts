/**
 * UdpPort - UDP datagram send/receive port
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * UdpPort provides a message-oriented abstraction over Bun's UDP socket API.
 * It implements the Port interface, allowing UDP sockets to be used uniformly
 * with other kernel port types (watch, tcp, etc).
 *
 * The port maintains an internal message queue for incoming datagrams. When
 * recv() is called and no messages are queued, the caller is suspended until
 * the next datagram arrives. This provides a clean async iterator-style API
 * over the callback-based Bun socket interface.
 *
 * Outbound messages are sent directly via socket.send() with no buffering.
 * UDP is unreliable and unordered, so the port makes no delivery guarantees.
 *
 * STATE MACHINE
 * =============
 *
 *   constructor() ──> LISTENING ──> CLOSED
 *                        │            ^
 *                        │ (recv)     │
 *                        └────────────┘
 *                           close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: socket is non-null IFF _closed is false
 * INV-2: waiters.length > 0 implies messageQueue.length === 0
 * INV-3: messageQueue.length > 0 implies waiters.length === 0
 * INV-4: Once _closed is true, it never becomes false again
 * INV-5: All messages in messageQueue contain valid from addresses
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but Bun's socket.data() callback can fire
 * at any time. Messages arriving while recv() is not active are queued.
 * Messages arriving while one or more recv() calls are waiting are delivered
 * immediately to the first waiter (FIFO order).
 *
 * There is no locking because all state mutations happen on the main event
 * loop. The socket callback and recv() cannot execute concurrently.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed flag before all recv() and send() operations
 * RC-2: Waiters must be removed from queue on port closure (no dangling promises)
 * RC-3: Socket closed before clearing state to prevent use-after-close
 *
 * MEMORY MANAGEMENT
 * =================
 * - Incoming datagrams are copied into Uint8Array buffers (necessary for Bun API)
 * - Message queue grows unbounded if recv() is not called
 * - Waiter queue grows unbounded if recv() is called faster than datagrams arrive
 * - close() clears both queues and nulls socket reference for GC
 *
 * @module kernel/resource/udp-port
 */

import type { PortType } from '@src/kernel/types.js';
import { EBADF, EINVAL } from '@src/kernel/errors.js';
import type { Port, PortMessage, UdpSocketOpts } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Bun UDP socket interface
 *
 * Typed interface for Bun.udpSocket() return value.
 * When Bun's types stabilize, mismatches will surface as compile errors.
 *
 * WHY: Provides type safety for untyped Bun API.
 * TESTABILITY: Allows mocking socket for unit tests.
 */
interface BunUdpSocket {
    /**
     * Send datagram to remote host:port.
     * WHY returns number: Bun returns bytes sent (always data.length for UDP)
     */
    send(data: Uint8Array, port: number, host: string): number;

    /** Close the socket and release OS resources */
    close(): void;
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * UDP port for sending and receiving datagrams.
 *
 * Each recv() returns a message with the sender's address in `from`.
 * send() requires a destination address in "host:port" format.
 */
export class UdpPort implements Port {
    // =========================================================================
    // PORT IDENTITY
    // =========================================================================

    /**
     * Port type identifier.
     *
     * WHY: Used by kernel to dispatch port operations correctly.
     * INVARIANT: Always 'udp:bind' for this class.
     */
    readonly type: PortType = 'udp:bind';

    /**
     * Unique port identifier.
     *
     * WHY: Allows kernel to track and close ports by ID.
     * INVARIANT: Immutable after construction.
     */
    readonly id: string;

    /**
     * Human-readable port description.
     *
     * WHY: Used in logs and debugging output.
     * INVARIANT: Immutable after construction.
     */
    readonly description: string;

    // =========================================================================
    // STATE MANAGEMENT
    // =========================================================================

    /**
     * Whether port has been closed.
     *
     * WHY: Prevents operations on closed ports.
     * INVARIANT: Once true, never becomes false (INV-4).
     */
    private _closed = false;

    /**
     * Queue of received messages awaiting recv() call.
     *
     * WHY: Buffers messages when they arrive faster than recv() is called.
     * INVARIANT: Non-empty only when waiters is empty (INV-3).
     */
    private messageQueue: PortMessage[] = [];

    /**
     * Queue of pending recv() calls awaiting messages.
     *
     * WHY: Suspends recv() callers until next datagram arrives.
     * INVARIANT: Non-empty only when messageQueue is empty (INV-2).
     * RACE CONDITION: Must be cleared on close() to prevent dangling promises.
     */
    private waiters: Array<(msg: PortMessage) => void> = [];

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Bun UDP socket instance.
     *
     * WHY: Provides OS-level datagram send/receive.
     * INVARIANT: Non-null IFF _closed is false (INV-1).
     */
    private socket: BunUdpSocket | null = null;

    /**
     * Socket configuration options.
     *
     * WHY: Stores bind address/port for socket initialization.
     */
    private opts: UdpSocketOpts;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new UDP port.
     *
     * ALGORITHM:
     * 1. Store configuration
     * 2. Start listening on specified address/port
     * 3. Register datagram callback
     *
     * @param id - Unique port identifier
     * @param opts - Socket options (bind address/port)
     * @param description - Human-readable description
     */
    constructor(id: string, opts: UdpSocketOpts, description: string) {
        this.id = id;
        this.opts = opts;
        this.description = description;

        // Start listening immediately - socket is ready after construction
        this.startListening();
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Whether port is closed.
     *
     * WHY: Exposes closure state for external checks.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // RECEIVE OPERATIONS
    // =========================================================================

    /**
     * Receive next datagram.
     *
     * ALGORITHM:
     * 1. Check if port is closed
     * 2. If messages queued, dequeue and return immediately
     * 3. Otherwise, create promise and enqueue waiter
     * 4. When datagram arrives, waiter's promise resolves
     *
     * RACE CONDITION:
     * Waiter promises must be rejected/cleared on close() to prevent
     * callers waiting forever on a closed port.
     *
     * @returns Message with sender address in `from` field
     * @throws EBADF - If port is closed
     */
    async recv(): Promise<PortMessage> {
        // RACE FIX: Check closure state before any operation
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // Fast path: return queued message if available
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        // Slow path: wait for next datagram to arrive
        // WHY no timeout: UDP recv() blocks until data or close()
        return new Promise(resolve => {
            this.waiters.push(resolve);
        });
    }

    // =========================================================================
    // SEND OPERATIONS
    // =========================================================================

    /**
     * Send datagram to remote host.
     *
     * ALGORITHM:
     * 1. Validate port state and parameters
     * 2. Parse destination address (host:port format)
     * 3. Send datagram via socket.send()
     *
     * WHY data is required:
     * UDP is a network protocol - we enforce presence at port boundary.
     * Empty datagrams are technically valid but rarely useful.
     *
     * @param to - Destination address in "host:port" format
     * @param data - Datagram bytes to send
     * @param _meta - Unused (kept for Port interface compatibility)
     * @throws EBADF - If port is closed or socket not initialized
     * @throws EINVAL - If address format is invalid or data is missing
     */
    async send(to: string, data?: Uint8Array, _meta?: Record<string, unknown>): Promise<void> {
        // RACE FIX: Check closure state before any operation
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // UDP requires data (network boundary validation)
        if (!data) {
            throw new EINVAL('UDP send requires data');
        }

        // Parse "host:port" format
        // WHY lastIndexOf: supports IPv6 addresses like [::1]:8080
        const lastColon = to.lastIndexOf(':');

        if (lastColon === -1) {
            throw new EINVAL('Invalid address format, expected host:port');
        }

        const host = to.slice(0, lastColon);
        const port = parseInt(to.slice(lastColon + 1), 10);

        if (isNaN(port)) {
            throw new EINVAL('Invalid port number');
        }

        // Socket should be initialized in constructor
        if (!this.socket) {
            throw new EBADF('Socket not initialized');
        }

        // Send datagram (fire-and-forget - UDP has no delivery guarantee)
        this.socket.send(data, port, host);
    }

    // =========================================================================
    // CLEANUP OPERATIONS
    // =========================================================================

    /**
     * Close port and release resources.
     *
     * ALGORITHM:
     * 1. Mark as closed
     * 2. Close underlying socket
     * 3. Clear waiter and message queues
     *
     * WHY socket closed before clearing queues:
     * Prevents new callbacks from firing during cleanup.
     *
     * WHY waiters cleared without rejection:
     * Callers should check port.closed after recv(). Rejecting would
     * require error handling in every recv() call.
     *
     * Safe to call multiple times - subsequent calls are no-ops.
     */
    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        // Mark as closed first to fail in-flight operations
        this._closed = true;

        // Close socket to stop receiving datagrams
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        // RACE FIX: Clear waiters to prevent dangling promises
        // WHY no rejection: Callers should check closed state
        this.waiters = [];
        this.messageQueue = [];
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Initialize UDP socket and start receiving datagrams.
     *
     * ALGORITHM:
     * 1. Create Bun UDP socket with specified bind address
     * 2. Register data callback for incoming datagrams
     * 3. Register error callback for socket errors
     *
     * WHY self capture:
     * Callback closures need stable reference to `this`. Arrow functions
     * in socket config would capture wrong context.
     */
    private startListening(): void {
        const self = this;

        this.socket = Bun.udpSocket({
            port: this.opts.bind,
            hostname: this.opts.address ?? '0.0.0.0',

            socket: {
                /**
                 * Handle incoming datagram.
                 *
                 * RACE CONDITION:
                 * This callback can fire at any time. If waiters exist,
                 * deliver immediately. Otherwise queue for later recv().
                 */
                data(_socket, buf, port, addr) {
                    // WHY create new Uint8Array: buf is reused by Bun
                    const message: PortMessage = {
                        from: `${addr}:${port}`,
                        data: new Uint8Array(buf),
                    };

                    // Fast path: deliver to waiting recv() call
                    if (self.waiters.length > 0) {
                        const waiter = self.waiters.shift()!;

                        waiter(message);
                    }
                    else {
                        // Slow path: queue for later recv() call
                        self.messageQueue.push(message);
                    }
                },

                /**
                 * Handle socket errors.
                 *
                 * WHY console.error: No kernel logging available in callback context.
                 * Production systems should inject logger dependency.
                 */
                error(_socket, error) {
                    console.error('UDP socket error:', error);
                },
            },
        }) as unknown as BunUdpSocket;
    }
}
