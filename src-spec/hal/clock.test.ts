import { describe, it, expect, beforeEach } from 'bun:test';
import { BunClockDevice, MockClockDevice } from '@src/hal/index.js';

describe('Clock Device', () => {
    describe('BunClockDevice', () => {
        let clock: BunClockDevice;

        beforeEach(() => {
            clock = new BunClockDevice();
        });

        describe('now', () => {
            it('should return current wall clock time in milliseconds', () => {
                const before = Date.now();
                const clockTime = clock.now();
                const after = Date.now();

                expect(clockTime).toBeGreaterThanOrEqual(before);
                expect(clockTime).toBeLessThanOrEqual(after);
            });

            it('should increase over time', async () => {
                const t1 = clock.now();
                await Bun.sleep(10);
                const t2 = clock.now();
                expect(t2).toBeGreaterThan(t1);
            });
        });

        describe('monotonic', () => {
            it('should return bigint', () => {
                const mono = clock.monotonic();
                expect(typeof mono).toBe('bigint');
            });

            it('should never go backward', () => {
                const values: bigint[] = [];
                for (let i = 0; i < 100; i++) {
                    values.push(clock.monotonic());
                }
                for (let i = 1; i < values.length; i++) {
                    expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
                }
            });

            it('should increase over time', async () => {
                const m1 = clock.monotonic();
                await Bun.sleep(10);
                const m2 = clock.monotonic();
                expect(m2).toBeGreaterThan(m1);
            });
        });

        describe('uptime', () => {
            it('should return non-negative value', () => {
                expect(clock.uptime()).toBeGreaterThanOrEqual(0);
            });

            it('should increase over time', async () => {
                const u1 = clock.uptime();
                await Bun.sleep(50);
                const u2 = clock.uptime();
                expect(u2).toBeGreaterThan(u1);
            });

            it('should roughly match elapsed time', async () => {
                const clock2 = new BunClockDevice();
                await Bun.sleep(100);
                const uptime = clock2.uptime();
                // Should be roughly 100ms, allow some tolerance
                expect(uptime).toBeGreaterThanOrEqual(90);
                expect(uptime).toBeLessThanOrEqual(200);
            });
        });
    });

    describe('MockClockDevice', () => {
        let clock: MockClockDevice;

        beforeEach(() => {
            clock = new MockClockDevice();
        });

        describe('initial state', () => {
            it('should start at time 0', () => {
                expect(clock.now()).toBe(0);
            });

            it('should have monotonic time 0', () => {
                expect(clock.monotonic()).toBe(0n);
            });

            it('should have uptime 0', () => {
                expect(clock.uptime()).toBe(0);
            });
        });

        describe('set', () => {
            it('should set wall clock time', () => {
                clock.set(1000);
                expect(clock.now()).toBe(1000);
            });

            it('should not affect monotonic time', () => {
                clock.set(1000);
                expect(clock.monotonic()).toBe(0n);
            });
        });

        describe('advance', () => {
            it('should advance wall clock', () => {
                clock.advance(500);
                expect(clock.now()).toBe(500);
            });

            it('should advance monotonic time in nanoseconds', () => {
                clock.advance(100);
                expect(clock.monotonic()).toBe(100_000_000n);
            });

            it('should accumulate', () => {
                clock.advance(100);
                clock.advance(200);
                expect(clock.now()).toBe(300);
                expect(clock.monotonic()).toBe(300_000_000n);
            });
        });

        describe('setMono', () => {
            it('should set monotonic time directly', () => {
                clock.setMono(5_000_000_000n);
                expect(clock.monotonic()).toBe(5_000_000_000n);
            });
        });

        describe('reset', () => {
            it('should reset all values to 0', () => {
                clock.set(1000);
                clock.advance(500);
                clock.setMono(1_000_000n);

                clock.reset();

                expect(clock.now()).toBe(0);
                expect(clock.monotonic()).toBe(0n);
                expect(clock.uptime()).toBe(0);
            });
        });

        describe('uptime', () => {
            it('should track time since boot', () => {
                clock.advance(1000);
                expect(clock.uptime()).toBe(1000);
            });
        });
    });
});
