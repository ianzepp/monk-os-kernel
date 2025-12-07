/**
 * TCP Socket - Bun socket wrapper
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module wraps Bun's event-driven socket API to provide a promise-based
 * read()/write() interface. Bun sockets emit 'data' events asynchronously, but
 * Monk OS needs synchronous-looking read() operations. We bridge this gap by
 * buffering incoming data and using Promises that resolve when data is available.
 *
 * The core challenge: Bun's event-driven model vs Monk OS's blocking I/O model.
 * Bun calls our 'data' handler whenever bytes arrive, but our read() method needs
 * to return those bytes on demand. We solve this with a queue and conditional logic:
 *
 * - Data arrives BEFORE read(): Buffer in dataQueue
 * - read() called BEFORE data arrives: Store resolver, wake it when data comes
 * - Socket closes: Wake any pending read() with EOF (empty Uint8Array)
 *
 * This design enables:
 * - Natural async/await code (await socket.read())
 * - Timeout support (reject if no data within timeout)
 * - Backpressure (read() blocks until data or EOF)
 * - Clean shutdown (close() wakes pending reads)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: dataQueue contains only valid Uint8Array instances
 * INV-2: dataResolve is non-null only when read() is blocked waiting
 * INV-3: Once closed=true, read() returns EOF and write() throws EBADF
 * INV-4: Getters/setters for dataResolve and closed always return current values
 * INV-5: Socket reference is valid until close() is called
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * read() calls may be pending (though unusual). Bun's event loop delivers 'data'
 * events asynchronously.
 *
 * Key concurrency points:
 * - Multiple read() calls: Only last one's resolver is stored (previous ones lost)
 * - Data arrives during read(): Resolver called immediately
 * - Data arrives with no read(): Buffered in queue
 * - close() during read(): Pending read() wakes with EOF
 * - write() during close(): Throws EBADF
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check closed flag before write operations
 * RC-2: Check dataQueue before creating Promise in read()
 * RC-3: Clear dataResolve on timeout to prevent double-resolution
 * RC-4: Wake pending read() on close to prevent hanging
 *
 * MEMORY MANAGEMENT
 * =================
 * - dataQueue managed by this class, cleared on consumption
 * - dataResolve stored only while read() is blocked
 * - Bun socket released via socket.end() in close()
 * - Timeout timers cleaned up on successful read
 *
 * TESTABILITY
 * ===========
 * - Constructor injection of state accessors enables testing
 * - read() timeout behavior testable with controlled delays
 * - write() error handling testable with closed sockets
 * - stat() returns deterministic socket metadata
 *
 * @module hal/network/socket
 */

import { ETIMEDOUT, EBADF } from '../errors.js';
import type { Socket, SocketReadOpts, SocketStat } from './types.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Bun socket wrapper providing read() interface.
 *
 * Bridges Bun's event-driven 'data' callbacks to promise-based read() method.
 * Maintains internal data queue and resolver for pending reads.
 *
 * WHY: Isolates socket buffering logic from listener. Enables testing of read/write
 * patterns independently.
 *
 * WHY getters/setters for dataResolve and closed:
 * These values are shared between this class and the event handlers created in
 * BunListener. We use getter/setter functions instead of direct property access
 * to ensure handlers always see the current value (they capture the getter/setter
 * functions, not the values themselves).
 */
export class BunSocket implements Socket {
    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create socket wrapper.
     *
     * ALGORITHM:
     * 1. Store socket reference
     * 2. Store data queue reference (shared with event handlers)
     * 3. Store state accessors (dataResolve, closed)
     *
     * WHY shared references:
     * Event handlers (created in BunListener) need to mutate dataQueue, dataResolve,
     * and closed flag. We receive references to these via constructor injection.
     * This enables the event handlers and this class to coordinate state.
     *
     * WHY getters/setters instead of direct properties:
     * Event handlers capture these functions at handler creation time. If we used
     * direct properties, handlers would capture the old values. Functions ensure
     * handlers always access current state.
     *
     * @param socket - Underlying Bun socket
     * @param dataQueue - Shared data buffer (mutated by event handlers)
     * @param _getDataResolve - Getter for pending read resolver
     * @param setDataResolve - Setter for pending read resolver
     * @param isClosed - Getter for closed flag
     * @param setClosed - Setter for closed flag
     */
    constructor(
        private socket: any, // Bun socket type
        private dataQueue: Uint8Array[],
        _getDataResolve: () => ((data: Uint8Array) => void) | null,
        private setDataResolve: (r: ((data: Uint8Array) => void) | null) => void,
        private isClosed: () => boolean,
        private setClosed: (c: boolean) => void,
    ) {}

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Read available data.
     *
     * ALGORITHM:
     * 1. If data queued: Return immediately
     * 2. If socket closed: Return EOF (empty Uint8Array)
     * 3. Otherwise: Create Promise, store resolver
     * 4. If timeout specified: Reject on timeout
     * 5. On data arrival or close: Event handler calls resolver
     *
     * RACE CONDITION:
     * Data may arrive before or after read() is called. We handle both:
     * - Data arrives first: Buffered in dataQueue (fast path)
     * - read() called first: Store resolver, wake on data arrival (slow path)
     *
     * RACE FIX:
     * Check dataQueue and closed state before creating Promise. This prevents
     * hanging reads if data arrived during the check.
     *
     * RACE FIX:
     * On timeout, clear dataResolve before rejecting. This prevents late data
     * arrival from calling a stale resolver.
     *
     * ERROR HANDLING:
     * - Timeout throws ETIMEDOUT
     * - Closed socket returns EOF (not an error)
     * - Invalid operations handled by caller
     *
     * @param opts - Read options (timeout)
     * @returns Promise resolving to data bytes or EOF
     * @throws ETIMEDOUT - If no data arrives within timeout
     */
    async read(opts?: SocketReadOpts): Promise<Uint8Array> {
        /**
         * Fast path: Return buffered data immediately.
         * WHY: Avoids Promise allocation if data already available.
         */
        if (this.dataQueue.length > 0) {
            return this.dataQueue.shift()!;
        }

        /**
         * Fast path: Return EOF if closed.
         * WHY: Closed socket will never receive more data. Return immediately
         * instead of creating a Promise that would resolve to EOF anyway.
         */
        if (this.isClosed()) {
            return new Uint8Array(0);
        }

        /**
         * Slow path: Wait for data or close.
         * WHY: No buffered data and socket open - must wait.
         */

        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            /**
             * Set timeout if requested.
             * RACE FIX: Clear dataResolve before rejecting. This prevents late
             * data arrival from calling a stale resolver (which would throw or
             * cause double-resolution).
             *
             * WHY: Prevents read() from blocking indefinitely if peer stalls.
             * Essential for implementing protocol timeouts.
             */
            if (opts?.timeout) {
                timeoutId = setTimeout(() => {
                    this.setDataResolve(null);
                    reject(new ETIMEDOUT('Read timeout'));
                }, opts.timeout);
            }

            /**
             * Store resolver for data arrival or close.
             * WHY: Event handlers will call this when data arrives or socket closes.
             *
             * RACE CONDITION: If multiple read() calls are pending, only the last
             * one's resolver is stored. Previous ones are lost. This is acceptable
             * because multiple pending reads is unusual and would indicate caller
             * logic error.
             */
            this.setDataResolve(data => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }

                resolve(data);
            });

            /**
             * RACE FIX: Check if closed AFTER setting resolver.
             * WHY: Close handler may have fired between isClosed() check above and
             * here. If so, close handler saw dataResolve as null and did nothing.
             * We must detect this and resolve with EOF ourselves.
             */
            if (this.isClosed()) {
                this.setDataResolve(null);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }

                resolve(new Uint8Array(0));
            }
        });
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    /**
     * Write data to socket.
     *
     * ALGORITHM:
     * 1. Check if socket is closed (throw if so)
     * 2. Call socket.write() with data
     * 3. If less than all data written: Bun buffered remainder
     * 4. Return (Bun handles backpressure internally)
     *
     * RACE CONDITION:
     * Socket may close between our closed check and write() call. Bun's write()
     * will fail safely - we rely on Bun to handle this race.
     *
     * BACKPRESSURE:
     * Bun's socket.write() returns number of bytes written. If less than data.length,
     * the rest is queued internally. Bun handles the buffering and drain events.
     * We don't wait for drain - this is fire-and-forget writing.
     *
     * WHY not wait for drain:
     * Monk OS's write() semantics are "queue this data" not "wait for send".
     * Waiting for drain would block the calling process unnecessarily. Bun's
     * internal buffering provides backpressure at the kernel level.
     *
     * ERROR HANDLING:
     * - Closed socket throws EBADF
     * - Bun write errors propagate as exceptions
     *
     * @param data - Bytes to write
     * @returns Promise resolving when write queued
     * @throws EBADF - If socket closed
     */
    async write(data: Uint8Array): Promise<void> {
        /**
         * Check closed state.
         * WHY: Prevents write to closed socket. Once closed, all writes fail.
         */
        if (this.isClosed()) {
            throw new EBADF('Socket closed');
        }

        /**
         * Write data to socket.
         * WHY: Bun's socket.write() queues data for send. Returns bytes written
         * (may be less than requested if kernel buffer full).
         */
        const written = this.socket.write(data);

        /**
         * Handle partial write (Bun buffered remainder).
         * WHY: If written < data.length, Bun queued the rest. This is normal
         * and expected - Bun will drain it asynchronously.
         *
         * CAVEAT: We don't wait for drain. This means write() may complete before
         * data actually hits the wire. This is standard socket behavior and matches
         * POSIX write() semantics (write to kernel buffer, not to wire).
         */
        if (written < data.length) {
            // Data was buffered; Bun will drain it
            // For now, we don't wait for drain - Bun handles backpressure
        }
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Close socket and release resources.
     *
     * ALGORITHM:
     * 1. Set closed flag (prevents future writes)
     * 2. Call socket.end() for graceful close
     *
     * INVARIANTS:
     * - Idempotent (safe to call multiple times)
     * - After close(), read() returns EOF
     * - After close(), write() throws EBADF
     *
     * RACE CONDITION:
     * Read or write may be in progress when close() is called. We set closed
     * flag first, then close socket. This ensures:
     * - New reads see closed=true and return EOF
     * - New writes see closed=true and throw EBADF
     * - In-flight operations complete naturally (socket.end() is graceful)
     *
     * WHY socket.end() not socket.close():
     * end() is graceful - allows buffered data to drain before closing. This
     * prevents data loss if write() queued data that hasn't been sent yet.
     *
     * @returns Promise resolving when socket closed
     */
    async close(): Promise<void> {
        this.setClosed(true);
        this.socket.end();
    }

    /**
     * AsyncDisposable support for `await using`.
     * WHY: Enables automatic cleanup in try-finally patterns.
     */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    // =========================================================================
    // METADATA
    // =========================================================================

    /**
     * Get socket metadata.
     *
     * WHY: Useful for logging, debugging, and access control. Returns peer
     * and local address information from Bun's socket properties.
     *
     * CAVEAT: Properties may be unavailable (e.g., Unix sockets have no port).
     * We use nullish coalescing to provide defaults.
     *
     * TESTABILITY: Returns deterministic data for assertions in tests.
     *
     * @returns Socket metadata (addresses and ports)
     */
    stat(): SocketStat {
        return {
            remoteAddr: this.socket.remoteAddress ?? 'unknown',
            remotePort: this.socket.remotePort ?? 0,
            localAddr: this.socket.localAddress ?? 'unknown',
            localPort: this.socket.localPort ?? 0,
        };
    }
}
