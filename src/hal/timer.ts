/**
 * Timer Device
 *
 * Timers for scheduling, delays, and watchdogs.
 *
 * Bun touchpoints:
 * - setTimeout() for one-shot timers
 * - setInterval() for repeating timers
 * - Bun.sleep() for async sleep
 * - clearTimeout() / clearInterval() for cancellation
 *
 * Caveats:
 * - Timer precision is limited by event loop granularity (~1ms)
 * - Long-running sync code blocks all timers
 * - setTimeout(fn, 0) doesn't mean "immediate" - it means "next tick"
 * - Maximum timeout is ~24.8 days (2^31 - 1 ms) in Node/Bun
 */

/**
 * Timer handle for cancellation
 */
export interface TimerHandle {
    /** Unique timer identifier */
    id: number;
    /** Timer type */
    type: 'timeout' | 'interval';
}

/**
 * Timer device interface.
 */
export interface TimerDevice {
    /**
     * Sleep for duration.
     *
     * Bun: Uses Bun.sleep() which is more efficient than
     * wrapping setTimeout in a Promise.
     *
     * Caveat: Actual sleep time may be longer due to event loop delay.
     * Use ClockDevice.monotonic() to measure actual elapsed time.
     *
     * @param ms - Milliseconds to sleep
     * @param signal - Optional abort signal for early wake
     * @throws AbortError if signal is aborted
     */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;

    /**
     * Call function repeatedly at interval.
     *
     * Bun: setInterval()
     *
     * Caveat: If callback takes longer than interval, calls will stack.
     * The callback should be fast or use its own async handling.
     *
     * @param ms - Interval in milliseconds
     * @param fn - Function to call
     * @returns Handle for cancellation
     */
    interval(ms: number, fn: () => void): TimerHandle;

    /**
     * Call function once after delay.
     *
     * Bun: setTimeout()
     *
     * @param ms - Delay in milliseconds
     * @param fn - Function to call
     * @returns Handle for cancellation
     */
    timeout(ms: number, fn: () => void): TimerHandle;

    /**
     * Cancel a timer.
     * No error if already cancelled or fired.
     *
     * Bun: clearTimeout() or clearInterval()
     */
    cancel(handle: TimerHandle): void;

    /**
     * Cancel all active timers.
     * Called during shutdown to release timer resources.
     */
    cancelAll(): void;
}

/**
 * Bun timer device implementation
 *
 * Bun touchpoints:
 * - Bun.sleep(ms) for async sleep
 * - setTimeout(fn, ms) for one-shot
 * - setInterval(fn, ms) for repeating
 * - clearTimeout/clearInterval for cancel
 *
 * Caveats:
 * - Bun.sleep() returns a Promise that resolves after ms
 * - No native AbortSignal support in Bun.sleep(); we race with abort
 */
export class BunTimerDevice implements TimerDevice {
    private nextId = 1;
    private timers = new Map<number, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        if (!signal) {
            // Simple case: no abort signal
            await Bun.sleep(ms);
            return;
        }

        // Race sleep against abort signal
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                reject(new DOMException('Aborted', 'AbortError'));
            };

            signal.addEventListener('abort', onAbort, { once: true });

            Bun.sleep(ms).then(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            });
        });
    }

    interval(ms: number, fn: () => void): TimerHandle {
        const id = this.nextId++;
        const handle = setInterval(fn, ms);
        this.timers.set(id, handle);
        return { id, type: 'interval' };
    }

    timeout(ms: number, fn: () => void): TimerHandle {
        const id = this.nextId++;
        const handle = setTimeout(() => {
            this.timers.delete(id);
            fn();
        }, ms);
        this.timers.set(id, handle);
        return { id, type: 'timeout' };
    }

    cancel(handle: TimerHandle): void {
        const timer = this.timers.get(handle.id);
        if (!timer) return;

        if (handle.type === 'interval') {
            clearInterval(timer);
        } else {
            clearTimeout(timer);
        }
        this.timers.delete(handle.id);
    }

    cancelAll(): void {
        for (const [_id, timer] of this.timers) {
            // Check by examining the timer - intervals are tracked separately
            clearTimeout(timer as ReturnType<typeof setTimeout>);
            clearInterval(timer as ReturnType<typeof setInterval>);
        }
        this.timers.clear();
    }
}

/**
 * Mock timer device for testing
 *
 * Allows manual time advancement for deterministic tests.
 *
 * Usage:
 *   const timer = new MockTimerDevice();
 *   timer.timeout(1000, () => console.log('fired'));
 *   timer.advance(500);  // not fired yet
 *   timer.advance(500);  // fires now
 */
export class MockTimerDevice implements TimerDevice {
    private nextId = 1;
    private currentTime = 0;
    private pendingTimers: Array<{
        id: number;
        type: 'timeout' | 'interval';
        triggerAt: number;
        interval?: number;
        fn: () => void;
    }> = [];
    private sleepResolvers: Array<{
        resolveAt: number;
        resolve: () => void;
        reject: (err: Error) => void;
        signal?: AbortSignal;
    }> = [];

    /**
     * Get current mock time
     */
    now(): number {
        return this.currentTime;
    }

    /**
     * Advance time and fire due timers
     */
    advance(ms: number): void {
        const targetTime = this.currentTime + ms;

        while (this.currentTime < targetTime) {
            // Find next event
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

            this.currentTime = nextEventTime;

            // Fire timers at current time
            const toFire = this.pendingTimers.filter((t) => t.triggerAt <= this.currentTime);
            for (const timer of toFire) {
                timer.fn();
                if (timer.type === 'interval' && timer.interval) {
                    timer.triggerAt += timer.interval;
                } else {
                    this.pendingTimers = this.pendingTimers.filter((t) => t.id !== timer.id);
                }
            }

            // Resolve sleepers at current time
            const toResolve = this.sleepResolvers.filter((s) => s.resolveAt <= this.currentTime);
            for (const sleeper of toResolve) {
                sleeper.resolve();
            }
            this.sleepResolvers = this.sleepResolvers.filter((s) => s.resolveAt > this.currentTime);
        }
    }

    /**
     * Reset mock timer state
     */
    reset(): void {
        this.currentTime = 0;
        this.pendingTimers = [];
        this.sleepResolvers = [];
    }

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
                signal.addEventListener(
                    'abort',
                    () => {
                        this.sleepResolvers = this.sleepResolvers.filter((s) => s !== entry);
                        reject(new DOMException('Aborted', 'AbortError'));
                    },
                    { once: true }
                );
            }

            this.sleepResolvers.push(entry);
        });
    }

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

    cancel(handle: TimerHandle): void {
        this.pendingTimers = this.pendingTimers.filter((t) => t.id !== handle.id);
    }

    cancelAll(): void {
        this.pendingTimers = [];
        // Reject all pending sleepers
        for (const sleeper of this.sleepResolvers) {
            sleeper.reject(new DOMException('Cancelled', 'AbortError'));
        }
        this.sleepResolvers = [];
    }
}
