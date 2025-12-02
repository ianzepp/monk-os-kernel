import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunTimerDevice, MockTimerDevice } from '@src/hal/index.js';

describe('Timer Device', () => {
    describe('BunTimerDevice', () => {
        let timer: BunTimerDevice;

        beforeEach(() => {
            timer = new BunTimerDevice();
        });

        afterEach(() => {
            timer.cancelAll();
        });

        describe('sleep', () => {
            it('should resolve after delay', async () => {
                const start = Date.now();
                await timer.sleep(50);
                const elapsed = Date.now() - start;
                expect(elapsed).toBeGreaterThanOrEqual(40);
                expect(elapsed).toBeLessThan(150);
            });

            it('should throw on immediate abort', async () => {
                const controller = new AbortController();
                controller.abort();

                await expect(timer.sleep(1000, controller.signal)).rejects.toThrow('Aborted');
            });

            it('should throw on abort during sleep', async () => {
                const controller = new AbortController();

                const sleepPromise = timer.sleep(1000, controller.signal);
                setTimeout(() => controller.abort(), 50);

                await expect(sleepPromise).rejects.toThrow('Aborted');
            });

            it('should complete if abort never called', async () => {
                const controller = new AbortController();
                await timer.sleep(50, controller.signal);
                // Should complete without throwing
            });
        });

        describe('timeout', () => {
            it('should call function after delay', async () => {
                let called = false;
                timer.timeout(50, () => {
                    called = true;
                });

                expect(called).toBe(false);
                await Bun.sleep(100);
                expect(called).toBe(true);
            });

            it('should return handle with id and type', () => {
                const handle = timer.timeout(1000, () => {});
                expect(typeof handle.id).toBe('number');
                expect(handle.type).toBe('timeout');
            });

            it('should not call function after cancel', async () => {
                let called = false;
                const handle = timer.timeout(50, () => {
                    called = true;
                });

                timer.cancel(handle);
                await Bun.sleep(100);
                expect(called).toBe(false);
            });
        });

        describe('interval', () => {
            it('should call function repeatedly', async () => {
                let count = 0;
                const handle = timer.interval(30, () => {
                    count++;
                });

                await Bun.sleep(100);
                timer.cancel(handle);
                expect(count).toBeGreaterThanOrEqual(2);
            });

            it('should return handle with interval type', () => {
                const handle = timer.interval(1000, () => {});
                expect(handle.type).toBe('interval');
                timer.cancel(handle);
            });

            it('should stop after cancel', async () => {
                let count = 0;
                const handle = timer.interval(30, () => {
                    count++;
                });

                await Bun.sleep(80);
                timer.cancel(handle);
                const countAtCancel = count;

                await Bun.sleep(80);
                expect(count).toBe(countAtCancel);
            });
        });

        describe('cancel', () => {
            it('should be safe to cancel twice', () => {
                const handle = timer.timeout(1000, () => {});
                timer.cancel(handle);
                timer.cancel(handle); // Should not throw
            });

            it('should be safe to cancel invalid handle', () => {
                timer.cancel({ id: 99999, type: 'timeout' });
            });
        });

        describe('cancelAll', () => {
            it('should cancel all timers', async () => {
                let count = 0;
                timer.timeout(30, () => count++);
                timer.timeout(30, () => count++);
                timer.interval(30, () => count++);

                timer.cancelAll();
                await Bun.sleep(100);
                expect(count).toBe(0);
            });
        });
    });

    describe('MockTimerDevice', () => {
        let timer: MockTimerDevice;

        beforeEach(() => {
            timer = new MockTimerDevice();
        });

        describe('now', () => {
            it('should start at 0', () => {
                expect(timer.now()).toBe(0);
            });
        });

        describe('advance', () => {
            it('should advance time', () => {
                timer.advance(100);
                expect(timer.now()).toBe(100);
            });

            it('should fire timeout at correct time', () => {
                let called = false;
                timer.timeout(50, () => {
                    called = true;
                });

                timer.advance(49);
                expect(called).toBe(false);

                timer.advance(1);
                expect(called).toBe(true);
            });

            it('should fire multiple timeouts in order', () => {
                const order: number[] = [];
                timer.timeout(100, () => order.push(100));
                timer.timeout(50, () => order.push(50));
                timer.timeout(75, () => order.push(75));

                timer.advance(200);
                expect(order).toEqual([50, 75, 100]);
            });

            it('should fire interval repeatedly', () => {
                let count = 0;
                timer.interval(30, () => {
                    count++;
                });

                timer.advance(100);
                expect(count).toBe(3); // At 30, 60, 90
            });
        });

        describe('sleep', () => {
            it('should resolve when time advanced', async () => {
                let resolved = false;
                const sleepPromise = timer.sleep(100).then(() => {
                    resolved = true;
                });

                expect(resolved).toBe(false);
                timer.advance(100);
                await sleepPromise;
                expect(resolved).toBe(true);
            });

            it('should throw on immediate abort', async () => {
                const controller = new AbortController();
                controller.abort();

                await expect(timer.sleep(1000, controller.signal)).rejects.toThrow('Aborted');
            });

            it('should throw when aborted', async () => {
                const controller = new AbortController();
                const sleepPromise = timer.sleep(1000, controller.signal);

                controller.abort();

                await expect(sleepPromise).rejects.toThrow('Aborted');
            });
        });

        describe('cancel', () => {
            it('should prevent timeout from firing', () => {
                let called = false;
                const handle = timer.timeout(50, () => {
                    called = true;
                });

                timer.cancel(handle);
                timer.advance(100);
                expect(called).toBe(false);
            });

            it('should stop interval', () => {
                let count = 0;
                const handle = timer.interval(30, () => {
                    count++;
                });

                timer.advance(50);
                expect(count).toBe(1);

                timer.cancel(handle);
                timer.advance(100);
                expect(count).toBe(1);
            });
        });

        describe('cancelAll', () => {
            it('should cancel all timers and reject sleepers', async () => {
                let count = 0;
                timer.timeout(50, () => count++);
                timer.interval(30, () => count++);

                const sleepPromise = timer.sleep(1000);

                timer.cancelAll();
                timer.advance(200);

                expect(count).toBe(0);
                await expect(sleepPromise).rejects.toThrow();
            });
        });

        describe('reset', () => {
            it('should clear all state', () => {
                timer.advance(100);
                timer.timeout(50, () => {});
                timer.reset();

                expect(timer.now()).toBe(0);
            });
        });
    });
});
