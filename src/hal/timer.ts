/**
 * Timer Device - Scheduling, delays, and watchdogs
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The TimerDevice provides time-based scheduling primitives for Monk OS. It
 * wraps JavaScript's setTimeout/setInterval and Bun's optimized sleep() to
 * provide a consistent, testable interface for delayed execution.
 *
 * Three primary operations are supported:
 *
 * 1. sleep(): Async sleep for a specified duration, optionally interruptible
 *    via AbortSignal. Used for delays in async workflows.
 *
 * 2. timeout(): Schedule a callback to fire once after a delay. Used for
 *    deferred actions, watchdog timers, retry delays.
 *
 * 3. interval(): Schedule a callback to fire repeatedly at fixed intervals.
 *    Used for polling, heartbeats, periodic cleanup.
 *
 * All timers can be cancelled via cancel() or cancelAll(). The device tracks
 * active timers via internal ID → handle mapping, enabling shutdown cleanup.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Timer IDs are unique and monotonically increasing
 * INV-2: cancel() is idempotent (safe to call on already-fired/cancelled timers)
 * INV-3: cancelAll() cancels ALL active timers, leaving no leaks
 * INV-4: Timeout callbacks fire exactly once
 * INV-5: Interval callbacks fire repeatedly until cancelled
 * INV-6: sleep() rejects with AbortError if signal is aborted (before or during sleep)
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded with cooperative multitasking via the event
 * loop. Timers do not run in parallel - they queue callbacks on the event loop.
 *
 * Timer callbacks must be synchronous (void return). If async work is needed,
 * callback should spawn a promise and handle errors internally. The timer
 * device does not await callbacks or handle their errors.
 *
 * Multiple timers can be scheduled concurrently. The event loop fires them in
 * order of expiration. If a callback blocks for longer than the interval, the
 * next callback may fire immediately after (no skipping).
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: sleep() races with AbortSignal - cleanup removes listener on either path
 * RC-2: timeout() self-cleans from map when firing to avoid memory leak
 * RC-3: cancel() checks existence before clearing to avoid double-clear bugs
 * RC-4: cancelAll() iterates map and clears both interval and timeout handles
 *
 * MEMORY MANAGEMENT
 * =================
 * - TimerDevice maintains internal map of active timer ID → native handle
 * - Timeout timers self-remove from map when fired (no leak)
 * - Interval timers remain in map until explicitly cancelled
 * - cancelAll() clears map and cancels all native handles (called at shutdown)
 * - sleep() promises are tracked by JavaScript runtime, no manual cleanup needed
 *
 * PRECISION AND LIMITATIONS
 * =========================
 * Timer precision is limited by event loop granularity (~1-4ms depending on
 * platform and load). Timers may fire later than requested if:
 * - Event loop is blocked by long-running synchronous code
 * - System is under heavy load (CPU contention)
 * - Timer queue is deep (many timers firing simultaneously)
 *
 * Maximum timer duration is ~24.8 days (2^31 - 1 milliseconds) due to
 * JavaScript's setTimeout implementation using signed 32-bit integers.
 *
 * TESTABILITY
 * ===========
 * MockTimerDevice enables deterministic testing without real time delays:
 * - Manual time advancement via advance(ms)
 * - Verify callbacks fire at correct times
 * - No flakiness from timing races
 * - Fast test execution (no real sleeps)
 *
 * @module hal/timer
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Timer handle for cancellation
 *
 * WHY: Opaque handle returned by timeout/interval that can be passed to cancel().
 * Encapsulates both our internal ID and the timer type (for proper cleanup).
 *
 * INVARIANT: id is unique across all timers (never reused).
 */
export interface TimerHandle {
    /**
     * Unique timer identifier
     *
     * WHY: Maps to internal timer storage. Monotonically increasing counter
     * ensures uniqueness across device lifetime.
     */
    id: number;

    /**
     * Timer type
     *
     * WHY: Determines whether to call clearTimeout or clearInterval during
     * cancellation. JavaScript requires correct clear function for each type.
     */
    type: 'timeout' | 'interval';
}

/**
 * Timer device interface
 *
 * WHY: Defines the contract for time-based scheduling. Implementations can be
 * swapped for testing (MockTimerDevice) or alternative runtimes.
 */
export interface TimerDevice {
    /**
     * Sleep for duration
     *
     * Async sleep that resolves after specified milliseconds. Optionally
     * interruptible via AbortSignal.
     *
     * ALGORITHM:
     * 1. Check if signal already aborted → reject immediately
     * 2. If no signal, use Bun.sleep(ms) → resolve when done
     * 3. If signal, race Bun.sleep(ms) against signal abort event
     * 4. On abort, remove listener and reject with AbortError
     * 5. On sleep complete, remove listener and resolve
     *
     * WHY: Bun.sleep() is more efficient than Promise wrapping setTimeout.
     * Native implementation avoids unnecessary timer handle allocation.
     *
     * RACE CONDITION: Signal may abort during sleep. Listener cleanup ensures
     * no memory leak - listener removed on both resolution paths.
     *
     * CAVEAT: Actual sleep time may be longer due to event loop delay. Use
     * ClockDevice.monotonic() to measure actual elapsed time.
     *
     * @param ms - Milliseconds to sleep
     * @param signal - Optional abort signal for early wake
     * @throws AbortError if signal is aborted
     */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;

    /**
     * Call function repeatedly at interval
     *
     * Schedules callback to fire every ms milliseconds. Callback fires
     * immediately on first interval, then repeatedly until cancelled.
     *
     * ALGORITHM:
     * 1. Allocate unique timer ID
     * 2. Call setInterval(fn, ms) → get native handle
     * 3. Store mapping: id → handle
     * 4. Return { id, type: 'interval' }
     *
     * WHY: Intervals are useful for polling, heartbeats, periodic cleanup.
     * Manual scheduling with setTimeout would require re-scheduling after each
     * callback (more complex, more prone to bugs).
     *
     * CAVEAT: If callback takes longer than interval, calls will queue and fire
     * back-to-back. Callback should be fast or use its own async handling to
     * avoid blocking event loop.
     *
     * @param ms - Interval in milliseconds
     * @param fn - Function to call
     * @returns Handle for cancellation
     */
    interval(ms: number, fn: () => void): TimerHandle;

    /**
     * Call function once after delay
     *
     * Schedules callback to fire once after ms milliseconds.
     *
     * ALGORITHM:
     * 1. Allocate unique timer ID
     * 2. Wrap callback to self-clean: () => { delete map[id]; fn(); }
     * 3. Call setTimeout(wrapped, ms) → get native handle
     * 4. Store mapping: id → handle
     * 5. Return { id, type: 'timeout' }
     *
     * WHY: Self-cleaning wrapper prevents memory leak. Without it, fired timers
     * would remain in map forever.
     *
     * @param ms - Delay in milliseconds
     * @param fn - Function to call
     * @returns Handle for cancellation
     */
    timeout(ms: number, fn: () => void): TimerHandle;

    /**
     * Cancel a timer
     *
     * Cancels pending timer. No-op if already cancelled or fired.
     *
     * ALGORITHM:
     * 1. Lookup native handle in map by id
     * 2. If not found → return (already cancelled/fired)
     * 3. If found → call clearTimeout/clearInterval based on type
     * 4. Delete from map
     *
     * WHY: Idempotent cancellation simplifies error handling. Caller doesn't
     * need to track whether timer has fired.
     *
     * INVARIANT: After cancel(), timer will not fire.
     */
    cancel(handle: TimerHandle): void;

    /**
     * Cancel all active timers
     *
     * Cancels every timer registered with this device. Called during shutdown
     * to ensure no timers fire after HAL is destroyed.
     *
     * ALGORITHM:
     * 1. Iterate all entries in timer map
     * 2. For each entry, call clearTimeout and clearInterval (both are safe)
     * 3. Clear the map
     *
     * WHY: Both clearTimeout and clearInterval are safe to call on any handle.
     * We call both to avoid needing to track type during iteration (simpler).
     *
     * INVARIANT: After cancelAll(), timer map is empty.
     */
    cancelAll(): void;
}

// =============================================================================
// MAIN IMPLEMENTATION
// =============================================================================

/**
 * Bun timer device implementation
 *
 * Production implementation using Bun.sleep() and JavaScript setTimeout/setInterval.
 *
 * Bun touchpoints:
 * - Bun.sleep(ms) for async sleep (more efficient than setTimeout promise)
 * - setTimeout(fn, ms) for one-shot timers
 * - setInterval(fn, ms) for repeating timers
 * - clearTimeout/clearInterval for cancellation
 *
 * Caveats:
 * - Bun.sleep() returns a Promise that resolves after ms (no AbortSignal support)
 * - We race sleep against abort event to implement interruptible sleep
 * - Native handles are opaque - stored as ReturnType<typeof setTimeout/setInterval>
 */
export class BunTimerDevice implements TimerDevice {
    // =========================================================================
    // INTERNAL STATE
    // =========================================================================

    /**
     * Next timer ID
     *
     * WHY: Monotonically increasing counter ensures unique IDs across device
     * lifetime. Never resets (even after cancelAll), preventing ID reuse bugs.
     *
     * INVARIANT: Increases by 1 for each timeout/interval call.
     */
    private nextId = 1;

    /**
     * Active timer map
     *
     * WHY: Maps our internal IDs to native timer handles for cancellation.
     * Timeout timers self-remove when fired. Interval timers remain until
     * explicitly cancelled.
     *
     * MEMORY: Timeout timers are transient (self-cleaning). Interval timers
     * must be explicitly cancelled to avoid leak.
     */
    private timers = new Map<number, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

    // =========================================================================
    // SLEEP OPERATIONS
    // =========================================================================

    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        // FAST PATH: Signal already aborted
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // FAST PATH: No signal, just sleep
        if (!signal) {
            await Bun.sleep(ms);

            return;
        }

        // SLOW PATH: Race sleep against abort signal
        // WHY: Bun.sleep() doesn't support AbortSignal natively. We must race
        // the sleep promise against the abort event.
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                // WHY: Reject with standard AbortError (same as fetch, etc.)
                reject(new DOMException('Aborted', 'AbortError'));
            };

            // WHY: { once: true } ensures listener auto-removes after firing
            signal.addEventListener('abort', onAbort, { once: true });

            Bun.sleep(ms).then(() => {
                // RACE FIX: Sleep completed before abort. Remove listener to
                // prevent memory leak (signal may be long-lived).
                signal.removeEventListener('abort', onAbort);
                resolve();
            });
        });
    }

    // =========================================================================
    // TIMER SCHEDULING
    // =========================================================================

    interval(ms: number, fn: () => void): TimerHandle {
        const id = this.nextId++;
        const handle = setInterval(fn, ms);

        this.timers.set(id, handle);

        return { id, type: 'interval' };
    }

    timeout(ms: number, fn: () => void): TimerHandle {
        const id = this.nextId++;

        // WHY: Wrap callback to self-clean from map when fired. Without this,
        // every timeout would leak memory (map grows unbounded).
        const handle = setTimeout(() => {
            this.timers.delete(id);
            fn();
        }, ms);

        this.timers.set(id, handle);

        return { id, type: 'timeout' };
    }

    // =========================================================================
    // TIMER CANCELLATION
    // =========================================================================

    cancel(handle: TimerHandle): void {
        const timer = this.timers.get(handle.id);

        if (!timer) {
            return;
        } // Already cancelled or fired

        // WHY: clearInterval and clearTimeout are type-specific. Using wrong
        // one is a no-op (timer continues running).
        if (handle.type === 'interval') {
            clearInterval(timer);
        }
        else {
            clearTimeout(timer);
        }

        this.timers.delete(handle.id);
    }

    cancelAll(): void {
        // WHY: Call both clear functions on each handle. This is safe because
        // clearTimeout on an interval (or vice versa) is a no-op. Avoids
        // needing to track type during iteration.
        for (const [_id, timer] of this.timers) {
            clearTimeout(timer as ReturnType<typeof setTimeout>);
            clearInterval(timer as ReturnType<typeof setInterval>);
        }

        this.timers.clear();
    }
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Mock timer device for testing
 *
 * Provides deterministic, fast, controllable time for unit tests. No real
 * time passes - test code explicitly advances mock time via advance(ms).
 *
 * WHY: Tests using real timers are slow (must wait for actual delays) and
 * flaky (timing races, platform variability). Mock timers enable fast,
 * deterministic, isolated testing.
 *
 * USAGE:
 *   const timer = new MockTimerDevice();
 *   let fired = false;
 *   timer.timeout(1000, () => { fired = true });
 *   timer.advance(500);  // not fired yet
 *   assert(!fired);
 *   timer.advance(500);  // fires now
 *   assert(fired);
 *
 * TESTABILITY: All timing is controlled by test code via advance(). Tests can
 * verify exact timing behavior without waiting for real time to pass.
 */
export class MockTimerDevice implements TimerDevice {
    // =========================================================================
    // INTERNAL STATE
    // =========================================================================

    /**
     * Next timer ID
     *
     * WHY: Same as BunTimerDevice - unique IDs prevent confusion.
     */
    private nextId = 1;

    /**
     * Current mock time in milliseconds
     *
     * WHY: Simulated clock. Advances only when advance() is called. Starts at 0.
     */
    private currentTime = 0;

    /**
     * Pending timers
     *
     * WHY: Tracks all scheduled timers with their trigger times and callbacks.
     * When mock time reaches triggerAt, callback fires.
     *
     * MEMORY: Timeouts are removed after firing. Intervals remain and reschedule.
     */
    private pendingTimers: Array<{
        id: number;
        type: 'timeout' | 'interval';
        triggerAt: number;
        interval?: number; // Only set for interval timers
        fn: () => void;
    }> = [];

    /**
     * Pending sleep resolvers
     *
     * WHY: Tracks all active sleep() promises with their wake times. When mock
     * time reaches resolveAt, promise resolves.
     *
     * RACE CONDITION: Signal may abort before wake time. Entry is removed from
     * array when aborted (prevents double-resolution).
     */
    private sleepResolvers: Array<{
        resolveAt: number;
        resolve: () => void;
        reject: (err: Error) => void;
        signal?: AbortSignal;
    }> = [];

    // =========================================================================
    // TIME CONTROL
    // =========================================================================

    /**
     * Get current mock time
     *
     * WHY: Allows tests to verify time advancement and calculate expected
     * trigger times.
     */
    now(): number {
        return this.currentTime;
    }

    /**
     * Advance time and fire due timers
     *
     * Moves mock clock forward by ms milliseconds, firing all timers and
     * resolving all sleep() promises whose trigger time is reached.
     *
     * ALGORITHM:
     * 1. Calculate target time = current + ms
     * 2. While current < target:
     *    a. Find next event time (earliest timer/sleep trigger)
     *    b. Advance current to next event time
     *    c. Fire all timers at current time
     *    d. Resolve all sleepers at current time
     *    e. Reschedule interval timers
     * 3. Set current = target
     *
     * WHY: Step-wise advancement ensures events fire in correct order even if
     * multiple events trigger during the advance window. Intervals reschedule
     * after firing to simulate repeating behavior.
     *
     * @param ms - Milliseconds to advance
     */
    advance(ms: number): void {
        const targetTime = this.currentTime + ms;

        while (this.currentTime < targetTime) {
            // Find next event time
            let nextEventTime = targetTime;

            for (const timer of this.pendingTimers) {
                if (timer.triggerAt < nextEventTime) {
                    nextEventTime = timer.triggerAt;
                }
            }

            for (const sleeper of this.sleepResolvers) {
                if (sleeper.resolveAt < nextEventTime) {
                    nextEventTime = sleeper.resolveAt;
                }
            }

            // Advance to next event
            this.currentTime = nextEventTime;

            // Fire timers at current time
            const toFire = this.pendingTimers.filter(t => t.triggerAt <= this.currentTime);

            for (const timer of toFire) {
                timer.fn();
                // WHY: Intervals reschedule, timeouts are removed
                if (timer.type === 'interval' && timer.interval) {
                    timer.triggerAt += timer.interval;
                }
                else {
                    this.pendingTimers = this.pendingTimers.filter(t => t.id !== timer.id);
                }
            }

            // Resolve sleepers at current time
            const toResolve = this.sleepResolvers.filter(s => s.resolveAt <= this.currentTime);

            for (const sleeper of toResolve) {
                sleeper.resolve();
            }

            this.sleepResolvers = this.sleepResolvers.filter(s => s.resolveAt > this.currentTime);
        }
    }

    /**
     * Reset mock timer state
     *
     * WHY: Tests should start with clean slate. Call reset() between tests
     * to avoid state pollution.
     */
    reset(): void {
        this.currentTime = 0;
        this.pendingTimers = [];
        this.sleepResolvers = [];
    }

    // =========================================================================
    // SLEEP OPERATIONS (MOCKED)
    // =========================================================================

    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        return new Promise((resolve, reject) => {
            const entry = {
                resolveAt: this.currentTime + ms,
                resolve,
                reject,
                signal,
            };

            if (signal) {
                // RACE FIX: Remove entry from array when aborted to prevent
                // double-resolution if wake time is also reached.
                signal.addEventListener(
                    'abort',
                    () => {
                        this.sleepResolvers = this.sleepResolvers.filter(s => s !== entry);
                        reject(new DOMException('Aborted', 'AbortError'));
                    },
                    { once: true },
                );
            }

            this.sleepResolvers.push(entry);
        });
    }

    // =========================================================================
    // TIMER SCHEDULING (MOCKED)
    // =========================================================================

    interval(ms: number, fn: () => void): TimerHandle {
        const id = this.nextId++;

        this.pendingTimers.push({
            id,
            type: 'interval',
            triggerAt: this.currentTime + ms,
            interval: ms,
            fn,
        });

        return { id, type: 'interval' };
    }

    timeout(ms: number, fn: () => void): TimerHandle {
        const id = this.nextId++;

        this.pendingTimers.push({
            id,
            type: 'timeout',
            triggerAt: this.currentTime + ms,
            fn,
        });

        return { id, type: 'timeout' };
    }

    // =========================================================================
    // TIMER CANCELLATION (MOCKED)
    // =========================================================================

    cancel(handle: TimerHandle): void {
        this.pendingTimers = this.pendingTimers.filter(t => t.id !== handle.id);
    }

    cancelAll(): void {
        this.pendingTimers = [];
        // WHY: Reject all pending sleepers with AbortError to simulate cancellation
        for (const sleeper of this.sleepResolvers) {
            sleeper.reject(new DOMException('Cancelled', 'AbortError'));
        }

        this.sleepResolvers = [];
    }
}
