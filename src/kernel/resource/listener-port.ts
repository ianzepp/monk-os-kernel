/**
 * ListenerPort - TCP listener port wrapping HAL Listener
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ListenerPort wraps the HAL Listener interface to provide a unified Port abstraction
 * for accepting TCP connections. It implements the Port interface, allowing processes
 * to receive incoming connections as PortMessage objects containing socket handles.
 *
 * Unlike traditional ports that exchange data messages, ListenerPort produces connection
 * events. Each recv() call blocks until a client connects, then returns a PortMessage
 * containing the accepted socket. The socket can then be used for bidirectional
 * communication with the connected client.
 *
 * This design separates connection acceptance (handled by ListenerPort) from data
 * transfer (handled via the returned socket), which aligns with the POSIX socket
 * model and enables clean separation of concerns in network service implementations.
 *
 * STATE MACHINE
 * =============
 *
 *   constructor() ─────> OPEN ─────────> CLOSED
 *                          │                ^
 *                          │ recv() blocks  │
 *                          │ until accept   │
 *                          └────────────────┘
 *                              close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: type is always 'tcp:listen' for this port implementation
 * INV-2: Once _closed is true, it never becomes false again
 * INV-3: recv() only returns after a successful connection acceptance
 * INV-4: send() always throws ENOTSUP (listeners don't send)
 * INV-5: Multiple close() calls are safe (idempotent)
 * INV-6: listener reference is non-null until close() completes
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. The HAL Listener
 * handles queuing of incoming connections. Multiple concurrent recv() calls would
 * interleave at await points, with each call resolving when a connection arrives.
 *
 * The caller is responsible for serializing recv() calls if FIFO ordering matters.
 * The kernel's port management layer typically ensures only one process waits on
 * recv() at a time.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: _closed flag checked before operations to prevent use-after-close
 * RC-2: Idempotent close() prevents double-close errors
 * RC-3: HAL Listener.accept() handles connection backlog internally
 *
 * MEMORY MANAGEMENT
 * =================
 * - ListenerPort holds a reference to HAL Listener until close()
 * - Accepted sockets become independent resources managed by their owners
 * - Callers must close returned sockets to prevent descriptor leaks
 * - close() releases the listener resource and makes port unusable
 *
 * @module kernel/resource/listener-port
 */

import type { Listener } from '@src/hal/index.js';
import type { PortType } from '@src/kernel/types.js';
import { ENOTSUP } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * TCP listener port implementation.
 *
 * Wraps HAL Listener to provide Port interface for connection acceptance.
 * Each recv() blocks until a connection arrives, then returns a socket.
 */
export class ListenerPort implements Port {
    // =========================================================================
    // PORT IDENTITY
    // =========================================================================

    /**
     * Port type identifier.
     *
     * WHY: Distinguishes listener ports from other port types in kernel tables.
     * INVARIANT: Always 'tcp:listen' for this implementation.
     */
    readonly type: PortType = 'tcp:listen';

    /**
     * Unique port identifier.
     *
     * WHY: Enables kernel to track and revoke ports by ID.
     * INVARIANT: Immutable after construction.
     */
    readonly id: string;

    /**
     * Human-readable description.
     *
     * WHY: Aids debugging and process introspection.
     * Example: "tcp:listen:0.0.0.0:8080"
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether port has been closed.
     *
     * WHY: Prevents operations on closed ports.
     * INVARIANT: Once true, never becomes false again.
     */
    private _closed = false;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Underlying HAL listener.
     *
     * WHY: Provides platform-specific TCP listening implementation.
     * Null after close() to enable GC.
     */
    private listener: Listener;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new ListenerPort.
     *
     * @param id - Unique port identifier
     * @param listener - HAL listener to wrap
     * @param description - Human-readable description
     */
    constructor(
        id: string,
        listener: Listener,
        description: string
    ) {
        this.id = id;
        this.listener = listener;
        this.description = description;
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Check if port is closed.
     *
     * WHY: Exposes closure state for external checks.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // CONNECTION ACCEPTANCE
    // =========================================================================

    /**
     * Accept an incoming connection.
     *
     * Blocks until a client connects, then returns a PortMessage containing
     * the accepted socket.
     *
     * ALGORITHM:
     * 1. Call HAL listener.accept() (blocks until connection)
     * 2. Get remote address from socket stats
     * 3. Return PortMessage with socket and remote address as 'from'
     *
     * RACE CONDITION:
     * If close() is called while recv() is blocked in accept(), the HAL
     * listener will reject the accept() promise. The caller will receive
     * an error and should check the closed flag.
     *
     * @returns PortMessage containing accepted socket and remote address
     * @throws Error from HAL if accept fails or port is closed
     */
    async recv(): Promise<PortMessage> {
        // Accept blocks until connection arrives or listener closes
        const socket = await this.listener.accept();

        // Get remote endpoint for PortMessage 'from' field
        const stat = socket.stat();

        // WHY we include socket in message:
        // The Port interface is designed for message passing, but listener
        // ports are special - they deliver connection handles rather than
        // data messages. The socket is the "payload" of this connection event.
        return {
            from: `${stat.remoteAddr}:${stat.remotePort}`,
            socket,
        };
    }

    // =========================================================================
    // UNSUPPORTED OPERATIONS
    // =========================================================================

    /**
     * Send operation is not supported on listener ports.
     *
     * WHY: Listener ports are unidirectional - they only accept connections.
     * Data exchange happens via the accepted sockets, not the listener port.
     *
     * @throws ENOTSUP - Always throws, operation is not supported
     */
    async send(_to: string, _data?: Uint8Array, _meta?: Record<string, unknown>): Promise<void> {
        throw new ENOTSUP('tcp:listen ports do not support send');
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    /**
     * Close the listener port.
     *
     * Stops accepting new connections and releases the HAL listener.
     * Safe to call multiple times (idempotent).
     *
     * ALGORITHM:
     * 1. Check if already closed (return early if so)
     * 2. Set _closed flag
     * 3. Close underlying HAL listener
     *
     * RACE CONDITION:
     * If recv() is blocked in accept() when close() is called, the HAL
     * listener will reject the accept() promise. This is safe - the caller
     * will get an error and can check the closed flag.
     *
     * @returns Promise that resolves when cleanup completes
     */
    async close(): Promise<void> {
        // Idempotent close
        if (this._closed) {
            return;
        }

        // Mark closed before awaiting to prevent re-entry
        this._closed = true;

        // Close underlying listener
        // WHY we await: Ensures listener resources are released before returning
        await this.listener.close();
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Get listener address.
     *
     * Returns the hostname and port the listener is bound to.
     *
     * WHY: Enables processes to discover the actual listening address,
     * which is useful when binding to port 0 (random port assignment).
     *
     * @returns Object with hostname and port
     */
    addr(): { hostname: string; port: number } {
        return this.listener.addr();
    }
}
