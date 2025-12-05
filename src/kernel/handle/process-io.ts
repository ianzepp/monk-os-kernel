/**
 * ProcessIOHandle - Process I/O routing and tapping
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ProcessIOHandle mediates process stdin/stdout/stderr with Unix-style
 * redirection and tapping capabilities. Like shell redirects (|, >, >>, <),
 * but at the kernel handle level rather than shell level. This enables the
 * kernel to control process I/O routing independently of any shell.
 *
 * The handle maintains three types of connections:
 * - Source: Where read operations (recv) are routed to
 * - Target: Where write operations (send) are routed to
 * - Taps: Additional handles that receive copies of writes (tee behavior)
 *
 * Taps use an async queue architecture. When a write occurs, messages are
 * pushed instantly to all tap queues (non-blocking), then each tap drains
 * its queue at its own pace via an independent async loop. This prevents
 * slow taps from blocking the main I/O path.
 *
 * STATE MACHINE
 * =============
 *
 *   constructor() ──> OPEN ──────> CLOSED
 *                      │              ^
 *                      │ (addTap)     │
 *                      │              │
 *                      v              │
 *                  TAP_ACTIVE ────────┘
 *                   (removeTap)    close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Once closed, target, source, and taps are all null/cleared
 * INV-2: Each tap has exactly one queue and one drain loop running
 * INV-3: Tap queues are closed before tap entries are deleted
 * INV-4: Writes to target complete before messages are queued to taps
 * INV-5: A handle can only be added as a tap once (no duplicates)
 * INV-6: Closed taps always resolve waiting pull() with null
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave at await
 * points. Each tap has an independent drain loop running concurrently. Key
 * concurrency properties:
 *
 * - send() waits for target.exec() to complete before queuing to taps
 * - Tap queue push() is synchronous and instant (non-blocking)
 * - Each tap drains at its own pace independently
 * - Slow taps don't block the main I/O path or other taps
 * - close() stops all drain loops by closing queues
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Check closed state at entry to all exec operations
 * RC-2: Tap queues closed before entry removal to prevent use-after-free
 * RC-3: Drain loop checks for null from pull() indicating queue closure
 * RC-4: Target write completes fully before tap distribution to ensure ordering
 * RC-5: close() idempotent - safe to call multiple times
 *
 * MEMORY MANAGEMENT
 * =================
 * - Tap queues buffer messages in memory until drained
 * - Queue closure releases buffered messages immediately
 * - Drain loops terminate when queue.pull() returns null
 * - Handles (target/source/taps) are NOT closed by ProcessIOHandle
 * - Kernel owns handle lifecycle - this just manages references
 *
 * @module kernel/handle/process-io
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Handle, HandleType } from './types.js';

// =============================================================================
// TAP QUEUE IMPLEMENTATION
// =============================================================================

/**
 * Simple async queue for tap message buffering.
 *
 * ARCHITECTURE:
 * Producers (send operations) push messages instantly without blocking.
 * Consumers (drain loops) pull messages, waiting asynchronously if empty.
 * This enables decoupling of write speed from tap processing speed.
 *
 * INVARIANTS:
 * - Once closed, push() returns false and pull() returns null
 * - At most one waiter at a time (FIFO consumer)
 * - Items delivered in FIFO order
 */
class TapQueue<T> {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Buffered items waiting to be pulled.
     *
     * WHY: Stores messages when producer is faster than consumer.
     * INVARIANT: Empty when a consumer is waiting (items deliver directly).
     */
    private items: T[] = [];

    /**
     * Pending consumer waiting for an item.
     *
     * WHY: Enables instant delivery when consumer is faster than producer.
     * INVARIANT: At most one waiting consumer (FIFO).
     */
    private waiting: ((item: T) => void) | null = null;

    /**
     * Whether queue is closed.
     *
     * WHY: Prevents new pushes and signals drain loop to terminate.
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    // =========================================================================
    // ACCESSORS
    // =========================================================================

    /**
     * Whether queue is closed.
     *
     * TESTING: Allows tests to verify queue lifecycle.
     */
    get closed(): boolean {
        return this._closed;
    }

    /**
     * Number of buffered items.
     *
     * TESTING: Allows monitoring queue depth for backpressure signals.
     */
    get length(): number {
        return this.items.length;
    }

    // =========================================================================
    // QUEUE OPERATIONS
    // =========================================================================

    /**
     * Push an item to the queue. Instant, non-blocking.
     *
     * ALGORITHM:
     * 1. Return false if closed (no-op)
     * 2. If consumer waiting, deliver directly and wake them
     * 3. Otherwise, buffer the item
     *
     * WHY direct delivery:
     * Avoids unnecessary buffering when consumer is ready. Reduces latency
     * and memory pressure.
     *
     * @param item - Item to push
     * @returns true if queued, false if closed
     */
    push(item: T): boolean {
        if (this._closed) {
            return false;
        }

        if (this.waiting) {
            // Consumer is waiting, deliver directly without buffering
            const resolve = this.waiting;

            this.waiting = null;
            resolve(item);
        }
        else {
            // Buffer the item for later pull
            this.items.push(item);
        }

        return true;
    }

    /**
     * Pull an item from the queue. Waits if empty.
     *
     * ALGORITHM:
     * 1. If items buffered, return first immediately
     * 2. If closed, return null (end of stream)
     * 3. Otherwise, create promise and wait for push() or close()
     *
     * WHY null on closed:
     * Signals end of stream to drain loop. Allows clean termination
     * without exceptions.
     *
     * @returns Next item or null if closed and empty
     */
    async pull(): Promise<T | null> {
        if (this.items.length > 0) {
            return this.items.shift()!;
        }

        if (this._closed) {
            return null;
        }

        // Wait for an item or close
        return new Promise<T | null>(resolve => {
            this.waiting = (item: T) => resolve(item);
        });
    }

    /**
     * Close the queue. Waiting consumers get null.
     *
     * ALGORITHM:
     * 1. Mark closed
     * 2. Wake waiting consumer with null
     * 3. Clear buffered items
     *
     * WHY clear items:
     * Releases memory immediately. Messages are discarded because tap
     * is being removed - no point draining them.
     *
     * RACE CONDITION:
     * If pull() creates a waiter after close() checks but before items
     * are cleared, that waiter never gets resolved. Mitigated by clearing
     * items last and checking closed in pull() before waiting.
     */
    close(): void {
        this._closed = true;
        if (this.waiting) {
            const resolve = this.waiting;

            this.waiting = null;
            resolve(null as unknown as T);
        }

        this.items = [];
    }
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Entry for a tap with its queue and drain loop.
 *
 * INVARIANTS:
 * - queue and drainPromise exist for the lifetime of the tap
 * - queue.close() called before entry is deleted from map
 */
interface TapEntry {
    /** The tap handle receiving copies */
    handle: Handle;

    /** Queue buffering messages for this tap */
    queue: TapQueue<Message>;

    /** Promise for the drain loop (for awaiting termination if needed) */
    drainPromise: Promise<void>;
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * Process I/O handle that mediates between a process and its I/O destinations.
 *
 * Acts like shell redirects (| > >> <) but at the handle level, controlled
 * by the kernel rather than the shell. Enables:
 * - Routing process output to different destinations
 * - Tapping process I/O for observation (tee behavior)
 * - Injecting input from external sources
 *
 * Tap Architecture:
 * - Each tap has its own async queue and drain loop
 * - Writes push to tap queues instantly (non-blocking)
 * - Each tap drains at its own pace (slow taps don't block anything)
 *
 * Supported ops:
 * - recv: Read from source handle
 * - send: Write to target handle + queue to all taps
 * - stat: Get handle info
 *
 * The process sees a normal handle. The kernel controls where data flows.
 */
export class ProcessIOHandle implements Handle {
    // =========================================================================
    // HANDLE IDENTITY
    // =========================================================================

    /**
     * Handle type identifier.
     *
     * WHY: Used by kernel to dispatch operations to correct handle type.
     * INVARIANT: Always 'process-io'.
     */
    readonly type: HandleType = 'process-io';

    /**
     * Unique handle identifier.
     *
     * WHY: Allows kernel to track and revoke specific handle instances.
     */
    readonly id: string;

    /**
     * Human-readable description.
     *
     * WHY: Aids debugging and process inspection (e.g., "stdout", "stderr").
     */
    readonly description: string;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether handle is closed.
     *
     * WHY: Prevents operations on closed handles.
     * INVARIANT: Once true, never becomes false.
     */
    private _closed = false;

    // =========================================================================
    // I/O ROUTING
    // =========================================================================

    /**
     * Where writes go.
     *
     * WHY: Enables stdout/stderr redirection.
     * INVARIANT: null means writes fail with EBADF.
     */
    private target: Handle | null;

    /**
     * Where reads come from.
     *
     * WHY: Enables stdin redirection.
     * INVARIANT: null means reads fail with EBADF.
     */
    private source: Handle | null;

    /**
     * Taps with their queues and drain loops.
     *
     * WHY: Enables tee-like observation of I/O without blocking main path.
     * INVARIANT: Each entry has a running drain loop until queue is closed.
     */
    private taps: Map<Handle, TapEntry> = new Map();

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new ProcessIOHandle.
     *
     * @param id - Unique handle identifier
     * @param description - Human-readable description
     * @param opts - Optional initial target/source handles
     */
    constructor(
        id: string,
        description: string,
        opts?: {
            target?: Handle;
            source?: Handle;
        },
    ) {
        this.id = id;
        this.description = description;
        this.target = opts?.target ?? null;
        this.source = opts?.source ?? null;
    }

    // =========================================================================
    // ACCESSORS
    // =========================================================================

    /**
     * Whether handle is closed.
     *
     * TESTING: Allows external code to check closure state.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // TARGET/SOURCE MANAGEMENT
    // =========================================================================

    /**
     * Set the target handle (where writes go).
     *
     * WHY: Enables dynamic redirection of stdout/stderr.
     *
     * @param handle - New target handle or null to disable writes
     */
    setTarget(handle: Handle | null): void {
        this.target = handle;
    }

    /**
     * Get the current target handle.
     *
     * TESTING: Allows tests to verify routing configuration.
     *
     * @returns Current target or null
     */
    getTarget(): Handle | null {
        return this.target;
    }

    /**
     * Set the source handle (where reads come from).
     *
     * WHY: Enables dynamic redirection of stdin.
     *
     * @param handle - New source handle or null to disable reads
     */
    setSource(handle: Handle | null): void {
        this.source = handle;
    }

    /**
     * Get the current source handle.
     *
     * TESTING: Allows tests to verify routing configuration.
     *
     * @returns Current source or null
     */
    getSource(): Handle | null {
        return this.source;
    }

    // =========================================================================
    // TAP MANAGEMENT
    // =========================================================================

    /**
     * Add a tap handle (receives copies of writes).
     *
     * ALGORITHM:
     * 1. Check if tap already exists (no-op if duplicate)
     * 2. Create queue for buffering messages
     * 3. Start independent drain loop
     * 4. Store entry in map
     *
     * WHY independent drain loops:
     * Each tap processes at its own speed. A slow tap (logging to disk)
     * doesn't block fast taps (in-memory buffer) or the main I/O path.
     *
     * @param handle - Handle to receive write copies
     */
    addTap(handle: Handle): void {
        if (this.taps.has(handle)) {
            return;
        }

        const queue = new TapQueue<Message>();

        // Start drain loop (runs independently, doesn't block this method)
        const drainPromise = this.drainTap(handle, queue);

        this.taps.set(handle, { handle, queue, drainPromise });
    }

    /**
     * Remove a tap handle.
     *
     * ALGORITHM:
     * 1. Look up tap entry
     * 2. Close queue (stops drain loop)
     * 3. Delete entry from map
     *
     * WHY close queue first:
     * Ensures drain loop terminates before we delete the entry.
     * Prevents use-after-free if drain loop tries to access the entry.
     *
     * @param handle - Handle to stop tapping
     */
    removeTap(handle: Handle): void {
        const entry = this.taps.get(handle);

        if (!entry) {
            return;
        }

        // Close queue to stop drain loop (RC-2: prevents use-after-free)
        entry.queue.close();
        this.taps.delete(handle);
    }

    /**
     * Get all tap handles.
     *
     * TESTING: Allows tests to verify tap configuration.
     *
     * @returns Set of tap handles
     */
    getTaps(): Set<Handle> {
        return new Set(this.taps.keys());
    }

    /**
     * Get queue depth for a tap (for monitoring/debugging).
     *
     * TESTING: Allows tests to detect backpressure or verify queue draining.
     *
     * WHY useful:
     * Large queue depth indicates a slow tap. Monitoring can trigger
     * warnings or automatic tap removal to prevent memory exhaustion.
     *
     * @param handle - Tap handle to check
     * @returns Number of buffered messages or 0 if tap not found
     */
    getTapQueueDepth(handle: Handle): number {
        const entry = this.taps.get(handle);

        return entry?.queue.length ?? 0;
    }

    // =========================================================================
    // HANDLE OPERATIONS
    // =========================================================================

    /**
     * Execute an operation on this handle.
     *
     * ALGORITHM:
     * 1. Check if closed (RC-1: prevents operation on closed handle)
     * 2. Dispatch based on operation type
     * 3. Yield responses
     *
     * Supported operations:
     * - recv: Route to source handle
     * - send: Route to target handle + queue to taps
     * - stat: Return handle metadata
     *
     * @param msg - Message describing the operation
     * @returns Async iterable of responses
     */
    async *exec(msg: Message): AsyncIterable<Response> {
        // RACE FIX: Check closure state before any operation
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');

            return;
        }

        const op = msg.op;

        switch (op) {
            case 'recv':
                yield* this.recv(msg);
                break;

            case 'send':
                yield* this.send(msg);
                break;

            case 'stat':
                yield respond.ok({
                    type: 'process-io',
                    description: this.description,
                    hasTarget: this.target !== null,
                    hasSource: this.source !== null,
                    tapCount: this.taps.size,
                });
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    // =========================================================================
    // PRIVATE OPERATION HANDLERS
    // =========================================================================

    /**
     * Handle recv operation - read from source.
     *
     * @param msg - recv message
     * @returns Responses from source handle
     */
    private async *recv(msg: Message): AsyncIterable<Response> {
        if (!this.source) {
            yield respond.error('EBADF', 'No source configured for reading');

            return;
        }

        // Forward recv to source handle unchanged
        yield* this.source.exec(msg);
    }

    /**
     * Handle send operation - write to target + queue to taps.
     *
     * ALGORITHM:
     * 1. Send to target handle, collect responses
     * 2. Queue message to all tap queues (instant, non-blocking)
     * 3. Yield original target responses
     *
     * WHY this order (RC-4):
     * Target write completes before tap distribution. This ensures taps
     * see messages in the same order the target received them. If we
     * queued to taps first, a slow target could cause reordering.
     *
     * WHY collect responses:
     * We need to fully consume target responses before moving on.
     * AsyncIterable doesn't buffer - we must drain it synchronously.
     *
     * @param msg - send message
     * @returns Responses from target handle
     */
    private async *send(msg: Message): AsyncIterable<Response> {
        if (!this.target) {
            yield respond.error('EBADF', 'No target configured for writing');

            return;
        }

        // Send to target (synchronous with caller - RC-4: ensures ordering)
        const responses: Response[] = [];

        for await (const response of this.target.exec(msg)) {
            responses.push(response);
        }

        // Queue to all taps (instant, non-blocking)
        for (const entry of this.taps.values()) {
            entry.queue.push(msg);
        }

        // Yield original target responses
        for (const response of responses) {
            yield response;
        }
    }

    // =========================================================================
    // TAP DRAIN LOOP
    // =========================================================================

    /**
     * Drain loop for a tap. Runs independently, processing messages
     * from the queue at whatever pace the tap can handle.
     *
     * ALGORITHM:
     * 1. Pull message from queue (waits if empty)
     * 2. If null, queue is closed - terminate loop
     * 3. Send message to tap handle
     * 4. Discard tap responses (taps are observe-only)
     * 5. Repeat
     *
     * WHY discard tap responses:
     * Taps are for observation/logging. Their responses don't affect the
     * original I/O operation. Discarding prevents response mixing.
     *
     * WHY catch errors:
     * Tap failures shouldn't crash the kernel or affect the main I/O path.
     * A broken tap is silently ignored. Production systems could add
     * logging or auto-remove failing taps.
     *
     * RACE CONDITION (RC-3):
     * queue.pull() returns null when queue is closed. This signals
     * termination. Without this check, loop would run forever.
     *
     * @param handle - Tap handle to drain to
     * @param queue - Queue to drain from
     */
    private async drainTap(handle: Handle, queue: TapQueue<Message>): Promise<void> {
        while (true) {
            const msg = await queue.pull();

            // RACE FIX: Queue closed = tap removed (RC-3)
            if (msg === null) {
                break;
            }

            try {
                // Send to tap, drain responses (discarded)
                for await (const _ of handle.exec(msg)) {
                    // Discard tap responses (see WHY above)
                }
            }
            catch {
                // Tap errors don't affect anything
                // TODO: Consider logging or auto-remove on repeated failures
            }
        }
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    /**
     * Close the handle and stop all tap drain loops.
     *
     * ALGORITHM:
     * 1. Mark as closed (idempotent check)
     * 2. Close all tap queues (stops drain loops)
     * 3. Clear all references
     *
     * WHY not close handles:
     * Target/source/tap handles may be shared with other handles or used
     * elsewhere in the system. The kernel owns their lifecycle. We just
     * manage references.
     *
     * RACE CONDITION (RC-5):
     * Idempotent - safe to call multiple times. First call does cleanup,
     * subsequent calls are no-ops.
     */
    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        this._closed = true;

        // Close all tap queues to stop drain loops
        for (const entry of this.taps.values()) {
            entry.queue.close();
        }

        // Clear references (kernel manages handle lifecycle)
        this.target = null;
        this.source = null;
        this.taps.clear();
    }
}
