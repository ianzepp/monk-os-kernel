/**
 * Process I/O Handle
 *
 * Mediates process stdin/stdout/stderr with routing and tapping capabilities.
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Handle, HandleType } from './types.js';

/**
 * Simple async queue for tap message buffering.
 *
 * Producers push messages instantly (non-blocking).
 * Consumer pulls messages, waiting if queue is empty.
 */
class TapQueue<T> {
    private items: T[] = [];
    private waiting: ((item: T) => void) | null = null;
    private _closed = false;

    get closed(): boolean {
        return this._closed;
    }

    get length(): number {
        return this.items.length;
    }

    /**
     * Push an item to the queue. Instant, non-blocking.
     * Returns false if queue is closed.
     */
    push(item: T): boolean {
        if (this._closed) return false;

        if (this.waiting) {
            // Consumer is waiting, deliver directly
            const resolve = this.waiting;
            this.waiting = null;
            resolve(item);
        } else {
            // Buffer the item
            this.items.push(item);
        }
        return true;
    }

    /**
     * Pull an item from the queue. Waits if empty.
     * Returns null if queue is closed and empty.
     */
    async pull(): Promise<T | null> {
        if (this.items.length > 0) {
            return this.items.shift()!;
        }

        if (this._closed) {
            return null;
        }

        // Wait for an item
        return new Promise<T | null>((resolve) => {
            this.waiting = (item: T) => resolve(item);
        });
    }

    /**
     * Close the queue. Waiting consumers get null.
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

/**
 * Entry for a tap with its queue and drain loop.
 */
interface TapEntry {
    handle: Handle;
    queue: TapQueue<Message>;
    drainPromise: Promise<void>;
}

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
    readonly type: HandleType = 'process-io';
    private _closed = false;

    /** Where writes go */
    private target: Handle | null;

    /** Where reads come from */
    private source: Handle | null;

    /** Taps with their queues and drain loops */
    private taps: Map<Handle, TapEntry> = new Map();

    constructor(
        readonly id: string,
        readonly description: string,
        opts?: {
            target?: Handle;
            source?: Handle;
        }
    ) {
        this.target = opts?.target ?? null;
        this.source = opts?.source ?? null;
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Set the target handle (where writes go).
     */
    setTarget(handle: Handle | null): void {
        this.target = handle;
    }

    /**
     * Get the current target handle.
     */
    getTarget(): Handle | null {
        return this.target;
    }

    /**
     * Set the source handle (where reads come from).
     */
    setSource(handle: Handle | null): void {
        this.source = handle;
    }

    /**
     * Get the current source handle.
     */
    getSource(): Handle | null {
        return this.source;
    }

    /**
     * Add a tap handle (receives copies of writes).
     *
     * Creates a queue and starts an independent drain loop for this tap.
     * The tap processes messages at its own pace.
     */
    addTap(handle: Handle): void {
        if (this.taps.has(handle)) return;

        const queue = new TapQueue<Message>();

        // Start drain loop
        const drainPromise = this.drainTap(handle, queue);

        this.taps.set(handle, { handle, queue, drainPromise });
    }

    /**
     * Remove a tap handle.
     *
     * Stops the drain loop and discards any queued messages.
     */
    removeTap(handle: Handle): void {
        const entry = this.taps.get(handle);
        if (!entry) return;

        // Close queue to stop drain loop
        entry.queue.close();
        this.taps.delete(handle);
    }

    /**
     * Get all tap handles.
     */
    getTaps(): Set<Handle> {
        return new Set(this.taps.keys());
    }

    /**
     * Get queue depth for a tap (for monitoring/debugging).
     */
    getTapQueueDepth(handle: Handle): number {
        const entry = this.taps.get(handle);
        return entry?.queue.length ?? 0;
    }

    async *exec(msg: Message): AsyncIterable<Response> {
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

    private async *recv(msg: Message): AsyncIterable<Response> {
        if (!this.source) {
            yield respond.error('EBADF', 'No source configured for reading');
            return;
        }

        // Forward recv to source
        yield* this.source.exec(msg);
    }

    private async *send(msg: Message): AsyncIterable<Response> {
        if (!this.target) {
            yield respond.error('EBADF', 'No target configured for writing');
            return;
        }

        // Send to target (synchronous with caller)
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

    /**
     * Drain loop for a tap. Runs independently, processing messages
     * from the queue at whatever pace the tap can handle.
     */
    private async drainTap(handle: Handle, queue: TapQueue<Message>): Promise<void> {
        while (true) {
            const msg = await queue.pull();

            // Queue closed = tap removed
            if (msg === null) break;

            try {
                // Send to tap, drain responses
                for await (const _ of handle.exec(msg)) {
                    // Discard tap responses
                }
            } catch {
                // Tap errors don't affect anything
                // Could add logging or auto-remove on repeated failures
            }
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        // Close all tap queues to stop drain loops
        for (const entry of this.taps.values()) {
            entry.queue.close();
        }

        // Note: We don't close target/source/tap handles here.
        // They may be shared with other handles.
        // The kernel manages their lifecycle.
        this.target = null;
        this.source = null;
        this.taps.clear();
    }
}
