/**
 * StreamController - Backpressure and flow control for streaming syscalls
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * StreamController manages the flow of Response items from a kernel syscall
 * handler to a userland consumer. It implements consumer-driven backpressure
 * to prevent unbounded memory growth when the producer (kernel) is faster
 * than the consumer (process).
 *
 * The controller wraps an AsyncIterable source and:
 * - Tracks items yielded (itemsSent) vs. acknowledged (itemsAcked)
 * - Pauses iteration when gap >= HIGH_WATER
 * - Resumes iteration when ping brings gap <= LOW_WATER
 * - Detects stalled consumers (no ping for STALL_TIMEOUT)
 * - Supports cancellation via AbortController
 *
 * STATE MACHINE
 * =============
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │                                                                 │
 *   ▼                                                                 │
 * [IDLE] ──wrap()──> [STREAMING] ──gap>=HIGH──> [PAUSED]              │
 *                         │                        │                  │
 *                         │                        │ ping(gap<=LOW)   │
 *                         │                        ▼                  │
 *                         │<───────────────── [STREAMING]             │
 *                         │                                           │
 *                         │──done/cancel/stall──> [TERMINATED] ───────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: itemsSent >= itemsAcked (can't ack items not sent)
 *        VIOLATED BY: onPing() with processed > itemsSent
 * INV-2: resumeResolve is null when not paused
 *        VIOLATED BY: Calling waitForResume() while already paused
 * INV-3: After abort, wrap() stops yielding
 *        VIOLATED BY: Ignoring aborted signal in loop
 *
 * CONCURRENCY MODEL
 * =================
 * The controller runs in the kernel's main thread. The wrap() method is
 * an async generator that yields items. Between yields, the event loop
 * may deliver ping/cancel messages that call onPing()/onCancel().
 *
 * Synchronization is via callbacks:
 * - onPing() may resolve resumeResolve to unblock paused iteration
 * - onCancel() sets abort.signal.aborted which is checked each iteration
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Ping arrives while checking gap in wrap()
 *       MITIGATION: Gap check and resume are atomic in onPing()
 * RC-2: Cancel arrives while waiting for backpressure
 *       MITIGATION: Check abort.signal after every await
 * RC-3: Stall timeout vs. ping race
 *       MITIGATION: Safety timeout auto-resolves, stall recheck after resume
 *
 * MEMORY MANAGEMENT
 * =================
 * - Controller should be discarded after wrap() completes
 * - Caller must remove controller from registry on completion
 * - Safety timeout prevents permanent block if consumer dies
 *
 * @module syscall/stream/controller
 */

import type { StreamControllerDeps, StreamControllerConfig, StreamControllerOpts } from './types.js';
import {
    STREAM_HIGH_WATER,
    STREAM_LOW_WATER,
    STREAM_STALL_TIMEOUT,
} from './constants.js';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create default dependencies using global functions.
 *
 * WHY: Allows real usage without passing deps, while tests can override.
 */
function createDefaultDeps(): StreamControllerDeps {
    return {
        now: () => Date.now(),
        setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
        clearTimeout: (id) => globalThis.clearTimeout(id),
    };
}

/**
 * Merge user options with defaults.
 *
 * WHY: All fields become required internally, simplifying null checks.
 */
function resolveConfig(opts?: StreamControllerOpts): StreamControllerConfig {
    return {
        highWater: opts?.highWater ?? STREAM_HIGH_WATER,
        lowWater: opts?.lowWater ?? STREAM_LOW_WATER,
        stallTimeout: opts?.stallTimeout ?? STREAM_STALL_TIMEOUT,
    };
}

// =============================================================================
// STREAM CONTROLLER
// =============================================================================

/**
 * Controls backpressure and cancellation for a streaming syscall.
 *
 * USAGE:
 * ```typescript
 * const controller = new StreamController();
 * registry.set(requestId, controller);
 *
 * try {
 *     for await (const item of controller.wrap(source)) {
 *         sendToConsumer(item);
 *         if (isTerminal(item)) break;
 *     }
 * }
 * finally {
 *     registry.delete(requestId);
 * }
 * ```
 *
 * CALLER RESPONSIBILITIES:
 * - Register controller so ping/cancel handlers can find it
 * - Call onPing() when consumer sends stream_ping
 * - Call onCancel() when consumer sends stream_cancel
 * - Remove from registry after wrap() completes
 */
export class StreamController {
    // =========================================================================
    // PUBLIC STATE
    // =========================================================================

    /**
     * AbortController for stream cancellation.
     *
     * WHY: Public so caller can check abort.signal.aborted for additional
     * termination conditions (e.g., process killed).
     *
     * USAGE: Consumer sends stream_cancel → caller calls onCancel() →
     *        abort.abort() → wrap() loop exits
     */
    readonly abort = new AbortController();

    // =========================================================================
    // PRIVATE STATE
    // =========================================================================

    /**
     * Items sent to consumer (incremented after each yield in wrap).
     *
     * INVARIANT: itemsSent >= itemsAcked
     */
    private itemsSent = 0;

    /**
     * Items acknowledged by consumer via onPing().
     *
     * WHY: Consumer calls onPing(processed) periodically. We track this
     * to compute gap = itemsSent - itemsAcked for backpressure.
     */
    private itemsAcked = 0;

    /**
     * Timestamp of last ping from consumer.
     *
     * WHY: Detect stalled consumers. If now() - lastPingTime > stallTimeout,
     * consumer is unresponsive and stream should abort.
     */
    private lastPingTime: number;

    /**
     * Resolve function for backpressure pause.
     *
     * WHY: When gap >= highWater, wrap() awaits a Promise. When ping
     * brings gap <= lowWater, onPing() calls this to resume iteration.
     *
     * INVARIANT: null when not paused, non-null when paused
     */
    private resumeResolve: (() => void) | null = null;

    /**
     * Timeout ID for safety timeout during backpressure pause.
     *
     * WHY: If consumer dies, onPing() never runs. Safety timeout ensures
     * we resume and detect the stall rather than blocking forever.
     */
    private safetyTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    private readonly deps: StreamControllerDeps;
    private readonly config: StreamControllerConfig;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new StreamController.
     *
     * @param deps - Injectable dependencies (now, setTimeout, clearTimeout)
     * @param opts - Configuration options (highWater, lowWater, stallTimeout)
     */
    constructor(deps?: Partial<StreamControllerDeps>, opts?: StreamControllerOpts) {
        this.deps = { ...createDefaultDeps(), ...deps };
        this.config = resolveConfig(opts);
        this.lastPingTime = this.deps.now();
    }

    // =========================================================================
    // PUBLIC METHODS - PING/CANCEL HANDLERS
    // =========================================================================

    /**
     * Handle ping from consumer (acknowledges items processed).
     *
     * ALGORITHM:
     * 1. Update itemsAcked to processed count
     * 2. Update lastPingTime to now (for stall detection)
     * 3. If paused and gap <= lowWater, resume iteration
     *
     * RACE CONDITION:
     * Ping may arrive while wrap() is checking gap. The gap check and
     * resume are atomic within this function, ensuring consistency.
     *
     * @param processed - Number of items consumer has processed
     */
    onPing(processed: number): void {
        this.itemsAcked = processed;
        this.lastPingTime = this.deps.now();

        // Resume paused iteration if gap is now acceptable
        if (this.resumeResolve && this.gap <= this.config.lowWater) {
            this.resumeResolve();
            this.resumeResolve = null;
            this.clearSafetyTimeout();
        }
    }

    /**
     * Handle cancel from consumer (abort stream).
     *
     * WHY: Consumer may send stream_cancel to stop receiving items early.
     * This triggers abort.signal.aborted, causing wrap() to exit.
     */
    onCancel(): void {
        this.abort.abort();
        this.clearSafetyTimeout();

        // Also resume if paused - no point waiting
        if (this.resumeResolve) {
            this.resumeResolve();
            this.resumeResolve = null;
        }
    }

    // =========================================================================
    // PUBLIC METHODS - STREAM WRAPPER
    // =========================================================================

    /**
     * Wrap source iterable with backpressure control.
     *
     * ALGORITHM:
     * For each item from source:
     * 1. Check abort signal → exit if aborted
     * 2. Yield item to caller
     * 3. Increment itemsSent
     * 4. Reset lastPingTime on first item
     * 5. If gap >= highWater, pause until ping brings gap <= lowWater
     * 6. Check for stall after resume
     *
     * CALLER RESPONSIBILITY:
     * - Check for terminal items (ok/error/done/redirect) and break
     * - Check process state after awaiting
     * - Handle stall errors from this generator
     *
     * @param source - AsyncIterable to wrap
     * @yields Items from source, with backpressure applied
     * @throws StallError if consumer is unresponsive
     */
    async *wrap<T>(source: AsyncIterable<T>): AsyncIterable<T> {
        for await (const item of source) {
            // RC-2: Check abort before processing
            if (this.abort.signal.aborted) {
                return;
            }

            // Yield item to caller
            yield item;

            // Track for backpressure
            this.itemsSent++;

            // Reset ping timer on first item
            // WHY: Consumer starts pinging after receiving first item
            if (this.itemsSent === 1) {
                this.lastPingTime = this.deps.now();
            }

            // Stall detection (after first item only)
            if (this.itemsSent > 1 && this.isStalled()) {
                throw new StallError('Stream consumer unresponsive');
            }

            // Backpressure control
            if (this.gap >= this.config.highWater) {
                await this.waitForResume();

                // RC-2: Check abort after resume
                if (this.abort.signal.aborted) {
                    return;
                }

                // Stall check after resume
                if (this.isStalled()) {
                    throw new StallError('Stream consumer unresponsive');
                }
            }
        }
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing and diagnostics)
    // =========================================================================

    /**
     * Get current gap between sent and acknowledged items.
     *
     * TESTING: Allows tests to verify backpressure state.
     */
    get gap(): number {
        return this.itemsSent - this.itemsAcked;
    }

    /**
     * Check if consumer is stalled (no ping for too long).
     *
     * TESTING: Allows tests to verify stall detection.
     */
    isStalled(): boolean {
        return (this.deps.now() - this.lastPingTime) >= this.config.stallTimeout;
    }

    /**
     * Check if currently paused for backpressure.
     *
     * TESTING: Allows tests to verify pause state.
     */
    get isPaused(): boolean {
        return this.resumeResolve !== null;
    }

    /**
     * Get items sent count.
     *
     * TESTING: Allows tests to verify send count.
     */
    get sent(): number {
        return this.itemsSent;
    }

    /**
     * Get items acknowledged count.
     *
     * TESTING: Allows tests to verify ack count.
     */
    get acked(): number {
        return this.itemsAcked;
    }

    // =========================================================================
    // PRIVATE METHODS
    // =========================================================================

    /**
     * Wait for backpressure to clear (or safety timeout).
     *
     * ALGORITHM:
     * 1. Create promise that resolves when onPing() sees gap <= lowWater
     * 2. Set safety timeout to auto-resolve if consumer dies
     * 3. Await promise
     *
     * WHY SAFETY TIMEOUT:
     * If consumer crashes, onPing() never runs. Without safety timeout,
     * we'd block forever. Safety timeout ensures we resume and detect stall.
     */
    private waitForResume(): Promise<void> {
        return new Promise<void>(resolve => {
            this.resumeResolve = resolve;

            // Safety timeout prevents permanent block
            this.safetyTimeoutId = this.deps.setTimeout(() => {
                if (this.resumeResolve === resolve) {
                    this.resumeResolve();
                    this.resumeResolve = null;
                }
            }, this.config.stallTimeout);
        });
    }

    /**
     * Clear safety timeout.
     *
     * WHY: Called when resuming normally (via ping) to prevent timeout
     * from firing after we've already resumed.
     */
    private clearSafetyTimeout(): void {
        if (this.safetyTimeoutId !== null) {
            this.deps.clearTimeout(this.safetyTimeoutId);
            this.safetyTimeoutId = null;
        }
    }
}

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error thrown when consumer is unresponsive.
 *
 * WHY: Distinct error type allows caller to handle stalls specifically
 * (e.g., send ETIMEDOUT response, log, cleanup).
 */
export class StallError extends Error {
    readonly code = 'ETIMEDOUT';

    constructor(message: string) {
        super(message);
        this.name = 'StallError';
    }
}
