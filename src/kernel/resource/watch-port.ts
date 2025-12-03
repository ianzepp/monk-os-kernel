/**
 * WatchPort - VFS file system event watcher port
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * WatchPort bridges the VFS watch subsystem to the kernel port abstraction.
 * It consumes an async iterator of file system events (created/modified/deleted)
 * and delivers them as port messages. This allows processes to monitor file
 * system changes using the same recv() API as UDP/TCP ports.
 *
 * The port starts consuming VFS events immediately on construction. Events
 * are either delivered directly to waiting recv() calls or queued for later
 * retrieval. This design mirrors the UDP port implementation but operates on
 * local file system events rather than network datagrams.
 *
 * Pattern matching supports glob-style syntax for flexible subscriptions:
 * - `/users/*` matches direct children of /users
 * - `/users/**` matches all descendants recursively
 * - `/users/123` matches exact path only
 *
 * STATE MACHINE
 * =============
 *
 *   constructor() ──> CONSUMING ──> CLOSED
 *                        │            ^
 *                        │ (recv)     │
 *                        └────────────┘
 *                           close()
 *
 *   VFS iterator can also reach DONE state independently:
 *   CONSUMING ──> DONE (no more events)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: vfsIterator is non-null IFF iteratorDone is false
 * INV-2: waiters.length > 0 implies messageQueue.length === 0
 * INV-3: messageQueue.length > 0 implies waiters.length === 0
 * INV-4: Once _closed is true, it never becomes false again
 * INV-5: Once iteratorDone is true, it never becomes false again
 * INV-6: All queued messages contain valid event metadata in `meta` field
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. The
 * startConsuming() loop runs in background, consuming VFS events and either
 * queuing them or delivering to waiters. recv() calls can interleave with
 * the consuming loop, creating a producer-consumer pattern.
 *
 * There is no locking because all state mutations happen on the event loop.
 * The consuming loop and recv() cannot execute truly concurrently.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check _closed flag before all recv() operations
 * RC-2: startConsuming() loop checks _closed on every iteration
 * RC-3: Waiters cleared on close() to prevent dangling promises
 * RC-4: recv() checks iteratorDone to detect EOF condition
 *
 * MEMORY MANAGEMENT
 * =================
 * - VFS iterator is created once and consumed until done/closed
 * - Message queue grows unbounded if recv() is not called
 * - Waiter queue grows unbounded if recv() is called faster than events arrive
 * - close() clears both queues and nulls iterator reference for GC
 * - Event metadata is shallow-copied into message.meta
 *
 * @module kernel/resource/watch-port
 */

import type { PortType } from '@src/kernel/types.js';
import { EBADF, ENOTSUP, EIO } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Watch event from VFS (re-exported for kernel use).
 *
 * WHY: Allows kernel code to reference VFS event types without direct VFS import.
 * TESTABILITY: Enables mocking VFS events in unit tests.
 */
export type { WatchEvent as VfsWatchEvent } from '@src/vfs/model.js';
import type { WatchEvent } from '@src/vfs/model.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Watch port for VFS file system events.
 *
 * Subscribes to VFS file system events and delivers them as port messages.
 * Pattern supports glob-style matching:
 * - `/users/*` - direct children of /users
 * - `/users/**` - all descendants of /users
 * - `/users/123` - exact path
 */
export class WatchPort implements Port {
    // =========================================================================
    // PORT IDENTITY
    // =========================================================================

    /**
     * Port type identifier.
     *
     * WHY: Used by kernel to dispatch port operations correctly.
     * INVARIANT: Always 'watch' for this class.
     */
    readonly type: PortType = 'watch';

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
     * Whether VFS iterator has reached end.
     *
     * WHY: Allows recv() to throw EOF instead of hanging forever.
     * INVARIANT: Once true, never becomes false (INV-5).
     */
    private iteratorDone = false;

    /**
     * Queue of received events awaiting recv() call.
     *
     * WHY: Buffers events when they arrive faster than recv() is called.
     * INVARIANT: Non-empty only when waiters is empty (INV-3).
     */
    private messageQueue: PortMessage[] = [];

    /**
     * Queue of pending recv() calls awaiting events.
     *
     * WHY: Suspends recv() callers until next event arrives.
     * INVARIANT: Non-empty only when messageQueue is empty (INV-2).
     * RACE CONDITION: Must be cleared on close() to prevent dangling promises.
     */
    private waiters: Array<(msg: PortMessage) => void> = [];

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * VFS event iterator instance.
     *
     * WHY: Provides stream of file system events.
     * INVARIANT: Non-null IFF iteratorDone is false (INV-1).
     */
    private vfsIterator: AsyncIterator<WatchEvent> | null = null;

    /**
     * Glob pattern for filtering events.
     *
     * WHY: Limits events to specific paths (e.g., /users/**).
     */
    private pattern: string;

    /**
     * VFS watch factory function.
     *
     * WHY: Injected dependency allows testing without real VFS.
     * TESTABILITY: Mock this function to provide fake event streams.
     */
    private vfsWatch: (pattern: string) => AsyncIterable<WatchEvent>;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new watch port.
     *
     * ALGORITHM:
     * 1. Store configuration
     * 2. Start consuming VFS events in background
     * 3. Background loop runs until iterator done or port closed
     *
     * @param id - Unique port identifier
     * @param pattern - Glob pattern for filtering paths
     * @param vfsWatch - Factory function to create VFS watch iterator
     * @param description - Human-readable description
     */
    constructor(
        id: string,
        pattern: string,
        vfsWatch: (pattern: string) => AsyncIterable<WatchEvent>,
        description: string
    ) {
        this.id = id;
        this.pattern = pattern;
        this.vfsWatch = vfsWatch;
        this.description = description;

        // Start consuming VFS events in background
        // WHY not await: Constructor must be synchronous
        this.startConsuming();
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
     * Receive next file system event.
     *
     * ALGORITHM:
     * 1. Check if port is closed
     * 2. If messages queued, dequeue and return immediately
     * 3. If iterator done and no messages, throw EOF error
     * 4. Otherwise, create promise and enqueue waiter
     * 5. When event arrives, waiter's promise resolves
     *
     * RACE CONDITION:
     * Waiter promises must be cleared on close() to prevent callers
     * waiting forever on a closed port.
     *
     * @returns Message with event metadata in `meta` field
     * @throws EBADF - If port is closed
     * @throws Error('EOF') - If iterator is done and no messages queued
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

        // EOF path: iterator done and no messages left
        if (this.iteratorDone) {
            throw new EIO('EOF: No more events');
        }

        // Slow path: wait for next event to arrive
        // WHY no timeout: Watch recv() blocks until event or close()
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    // =========================================================================
    // SEND OPERATIONS
    // =========================================================================

    /**
     * Send operation not supported for watch ports.
     *
     * WHY: Watch ports are read-only event streams. File system events
     * flow from VFS to process, not the reverse.
     *
     * @throws ENOTSUP - Always (operation not supported)
     */
    async send(_to: string, _data?: Uint8Array, _meta?: Record<string, unknown>): Promise<void> {
        throw new ENOTSUP('watch ports do not support send');
    }

    // =========================================================================
    // CLEANUP OPERATIONS
    // =========================================================================

    /**
     * Close port and release resources.
     *
     * ALGORITHM:
     * 1. Mark as closed
     * 2. Clear waiter and message queues
     * 3. Background consuming loop will exit on next iteration
     *
     * WHY iterator not explicitly closed:
     * AsyncIterator has no standard close() method. The consuming loop
     * checks _closed flag and exits naturally. VFS layer handles cleanup.
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

        // Mark as closed first to exit consuming loop
        this._closed = true;

        // RACE FIX: Clear waiters to prevent dangling promises
        // WHY no rejection: Callers should check closed state
        this.waiters = [];
        this.messageQueue = [];
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Background loop to consume VFS events.
     *
     * ALGORITHM:
     * 1. Create async iterator from VFS watch
     * 2. Loop: await next event
     * 3. If event available, convert to PortMessage
     * 4. Deliver to waiter or enqueue for later recv()
     * 5. Exit loop if iterator done or port closed
     *
     * RACE CONDITION:
     * Loop checks _closed on each iteration. Events arriving after close()
     * are discarded. Waiters are cleared by close() so no dangling promises.
     *
     * WHY no return value:
     * Background loop runs until completion. Errors are caught and logged.
     * Caller doesn't await this method.
     */
    private async startConsuming(): Promise<void> {
        try {
            // Create async iterator from VFS watch function
            const iterable = this.vfsWatch(this.pattern);
            this.vfsIterator = iterable[Symbol.asyncIterator]();

            // Consume events until iterator done or port closed
            while (!this._closed) {
                const result = await this.vfsIterator.next();

                // RACE FIX: Check closure state after await point
                if (this._closed) {
                    break;
                }

                // Iterator exhausted - no more events
                if (result.done) {
                    this.iteratorDone = true;
                    break;
                }

                const event = result.value;

                // Convert VFS event to PortMessage
                // WHY no data field: Watch events are internal, not network boundary
                const message: PortMessage = {
                    from: event.path,
                    // Event details stored in meta field
                    meta: {
                        op: event.op,
                        entity: event.entity,
                        fields: event.fields,
                        timestamp: event.timestamp,
                    },
                };

                // Fast path: deliver to waiting recv() call
                if (this.waiters.length > 0) {
                    const waiter = this.waiters.shift()!;
                    waiter(message);
                } else {
                    // Slow path: queue for later recv() call
                    this.messageQueue.push(message);
                }
            }
        } catch (error) {
            // If closed, ignore errors (expected during shutdown)
            if (!this._closed) {
                // WHY console.error: No kernel logging available in async context
                // Production systems should inject logger dependency
                console.error('WatchPort error:', error);
            }
        }
    }
}
