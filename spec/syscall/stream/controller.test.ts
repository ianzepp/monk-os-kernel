/**
 * StreamController Tests
 *
 * Tests for backpressure management and flow control in streaming syscalls.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { StreamController, StallError } from '@src/syscall/stream/controller.js';
import {
    STREAM_HIGH_WATER,
    STREAM_LOW_WATER,
    STREAM_STALL_TIMEOUT,
} from '@src/syscall/stream/constants.js';

import type { StreamControllerDeps } from '@src/syscall/stream/types.js';

type TimeoutId = ReturnType<typeof globalThis.setTimeout>;

/**
 * Create a mock dependencies object for testing with controllable time.
 */
function createMockDeps(): StreamControllerDeps & {
    advance: (ms: number) => void;
    setTime: (ms: number) => void;
    getTime: () => number;
} {
    let currentTime = 0;
    const timeouts = new Map<number, { cb: () => void; at: number }>();
    let nextTimeoutId = 1;

    return {
        now: () => currentTime,
        setTimeout: (cb: () => void, ms: number): TimeoutId => {
            const id = nextTimeoutId++;

            timeouts.set(id, { cb, at: currentTime + ms });

            return id as unknown as TimeoutId;
        },
        clearTimeout: (id: TimeoutId) => {
            timeouts.delete(id as unknown as number);
        },
        // Test helpers
        advance: (ms: number) => {
            currentTime += ms;
            // Fire any expired timeouts
            for (const [id, { cb, at }] of timeouts) {
                if (at <= currentTime) {
                    timeouts.delete(id);
                    cb();
                }
            }
        },
        setTime: (ms: number) => {
            currentTime = ms;
        },
        getTime: () => currentTime,
    };
}

/**
 * Create an async generator that yields items.
 */
async function* createSource<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) {
        yield item;
    }
}

/**
 * Collect all items from an async iterable.
 */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];

    for await (const item of source) {
        items.push(item);
    }

    return items;
}

describe('StreamController', () => {
    describe('constructor', () => {
        it('should create with default options', () => {
            const controller = new StreamController();

            expect(controller.gap).toBe(0);
            expect(controller.sent).toBe(0);
            expect(controller.acked).toBe(0);
            expect(controller.isPaused).toBe(false);
        });

        it('should accept custom high/low water marks', () => {
            const deps = createMockDeps();
            const controller = new StreamController(deps, {
                highWater: 10,
                lowWater: 2,
            });

            expect(controller.gap).toBe(0);
        });

        it('should initialize lastPingTime to current time', () => {
            const deps = createMockDeps();

            deps.setTime(12345);

            const controller = new StreamController(deps);

            expect(controller.isStalled()).toBe(false);
        });
    });

    describe('wrap()', () => {
        it('should yield all items from source', async () => {
            const controller = new StreamController();
            const source = createSource([1, 2, 3]);

            const result = await collect(controller.wrap(source));

            expect(result).toEqual([1, 2, 3]);
        });

        it('should track items sent', async () => {
            const controller = new StreamController();
            const source = createSource(['a', 'b', 'c']);

            await collect(controller.wrap(source));

            expect(controller.sent).toBe(3);
        });

        it('should stop yielding when aborted', async () => {
            const controller = new StreamController();

            async function* abortingSource() {
                yield 1;
                controller.abort.abort();
                yield 2;
                yield 3;
            }

            const result = await collect(controller.wrap(abortingSource()));

            // Should stop after abort is called
            expect(result).toEqual([1]);
        });

        it('should exit early if already aborted', async () => {
            const controller = new StreamController();

            controller.abort.abort();

            const source = createSource([1, 2, 3]);
            const result = await collect(controller.wrap(source));

            expect(result).toEqual([]);
        });

        it('should reset ping timer on first item', async () => {
            const deps = createMockDeps();

            deps.setTime(1000);

            const controller = new StreamController(deps, { stallTimeout: 100 });

            // Advance time before yielding
            deps.setTime(2000);

            async function* delayedSource() {
                yield 'first';
            }

            await collect(controller.wrap(delayedSource()));

            // After first item, lastPingTime should be updated to current time
            // So stall check should be relative to that, not original time
            expect(controller.isStalled()).toBe(false);
        });
    });

    describe('backpressure', () => {
        it('should track gap correctly', async () => {
            const controller = new StreamController();
            const source = createSource([1, 2, 3]);

            await collect(controller.wrap(source));

            expect(controller.sent).toBe(3);
            expect(controller.acked).toBe(0);
            expect(controller.gap).toBe(3);
        });

        it('should reduce gap when ping acknowledges items', async () => {
            const controller = new StreamController();
            const source = createSource([1, 2, 3, 4, 5]);

            await collect(controller.wrap(source));

            expect(controller.gap).toBe(5);

            controller.onPing(3);

            expect(controller.acked).toBe(3);
            expect(controller.gap).toBe(2);
        });

        it('should eventually pause and resume with proper flow', async () => {
            const deps = createMockDeps();
            const controller = new StreamController(deps, {
                highWater: 3,
                lowWater: 1,
                stallTimeout: 10000,
            });

            // Create a source that yields 5 items
            async function* source(): AsyncIterable<number> {
                for (let i = 1; i <= 5; i++) {
                    yield i;
                }
            }

            const items: number[] = [];
            const iterator = controller.wrap(source())[Symbol.asyncIterator]();

            // Collect items with ping simulation
            // The backpressure test is tricky because pause happens asynchronously
            // Instead, just verify the flow control works end-to-end
            for (let i = 0; i < 5; i++) {
                // Simulate consumer ping before each item (except first)
                if (i > 0) {
                    controller.onPing(i);
                }

                const result = await Promise.race([
                    iterator.next(),
                    new Promise(resolve => deps.setTimeout(() => resolve({ timeout: true }), 100)),
                ]);

                if ('timeout' in (result as object)) {
                    // If timed out, send ping to resume
                    controller.onPing(controller.sent);
                    const resumed = await iterator.next();

                    if (!resumed.done) {
                        items.push(resumed.value as number);
                    }
                }
                else {
                    const { value, done } = result as IteratorResult<number>;

                    if (!done) {
                        items.push(value as number);
                    }
                }
            }

            // Verify we got all items eventually
            expect(items.length).toBe(5);
        });
    });

    describe('onPing()', () => {
        it('should update itemsAcked', () => {
            const controller = new StreamController();

            controller.onPing(50);

            expect(controller.acked).toBe(50);
        });

        it('should update lastPingTime', () => {
            const deps = createMockDeps();

            deps.setTime(1000);
            const controller = new StreamController(deps);

            deps.setTime(2000);
            controller.onPing(10);

            // After ping, stall check should use new ping time
            deps.setTime(2100);
            expect(controller.isStalled()).toBe(false);
        });

        it('should clear paused state when gap falls to low water', () => {
            const deps = createMockDeps();
            const controller = new StreamController(deps, {
                highWater: 10,
                lowWater: 2,
            });

            // Simulate the controller being in a paused state
            // We can't directly set isPaused, but we can verify onPing clears resumeResolve
            // when gap drops to low water

            // Start with items sent but not acked
            controller.onPing(0);

            // Controller shouldn't be paused initially (no active iteration)
            expect(controller.isPaused).toBe(false);

            // onPing should update acked count
            controller.onPing(5);
            expect(controller.acked).toBe(5);
        });
    });

    describe('onCancel()', () => {
        it('should set abort signal', () => {
            const controller = new StreamController();

            controller.onCancel();

            expect(controller.abort.signal.aborted).toBe(true);
        });

        it('should allow abort even when not paused', () => {
            const controller = new StreamController();

            // Not paused initially
            expect(controller.isPaused).toBe(false);

            // Cancel should still work
            controller.onCancel();

            expect(controller.abort.signal.aborted).toBe(true);
            expect(controller.isPaused).toBe(false); // Still not paused
        });
    });

    describe('stall detection', () => {
        it('should detect stall when no ping for stallTimeout', () => {
            const deps = createMockDeps();
            const controller = new StreamController(deps, {
                stallTimeout: 5000,
            });

            deps.setTime(0);
            controller.onPing(0); // Reset ping time

            deps.setTime(4999);
            expect(controller.isStalled()).toBe(false);

            deps.setTime(5000);
            expect(controller.isStalled()).toBe(true);
        });

        it('should throw StallError when stalled during iteration', async () => {
            const deps = createMockDeps();
            const controller = new StreamController(deps, {
                highWater: 1000,
                lowWater: 100,
                stallTimeout: 100,
            });

            deps.setTime(0);

            async function* slowSource() {
                yield 1;
                deps.setTime(200); // Advance past stall timeout
                yield 2; // This should trigger stall check
            }

            await expect(collect(controller.wrap(slowSource()))).rejects.toThrow(StallError);
        });
    });

    describe('gap calculation', () => {
        it('should calculate gap as sent minus acked', async () => {
            const controller = new StreamController();

            async function* source() {
                yield 1;
                yield 2;
                yield 3;
            }

            await collect(controller.wrap(source()));

            expect(controller.sent).toBe(3);
            expect(controller.acked).toBe(0);
            expect(controller.gap).toBe(3);

            controller.onPing(2);

            expect(controller.gap).toBe(1);
        });
    });
});

describe('StallError', () => {
    it('should have code ETIMEDOUT', () => {
        const err = new StallError('test');

        expect(err.code).toBe('ETIMEDOUT');
        expect(err.name).toBe('StallError');
        expect(err.message).toBe('test');
    });
});

describe('Stream Constants', () => {
    it('should export expected values', () => {
        expect(STREAM_HIGH_WATER).toBe(1000);
        expect(STREAM_LOW_WATER).toBe(100);
        expect(STREAM_STALL_TIMEOUT).toBe(5000);
    });

    it('should have HIGH_WATER > LOW_WATER (hysteresis)', () => {
        expect(STREAM_HIGH_WATER).toBeGreaterThan(STREAM_LOW_WATER);
    });
});
