import { describe, it, expect, beforeEach } from 'bun:test';
import { MockIPCDevice, BunIPCDevice } from '@src/hal/index.js';

describe('IPC Device', () => {
    describe('MockIPCDevice', () => {
        let ipc: MockIPCDevice;

        beforeEach(() => {
            ipc = new MockIPCDevice();
        });

        describe('alloc', () => {
            it('should allocate SharedArrayBuffer', () => {
                const buf = ipc.alloc(1024);

                expect(buf).toBeInstanceOf(SharedArrayBuffer);
                expect(buf.byteLength).toBe(1024);
            });
        });

        describe('port', () => {
            it('should return two connected ports', () => {
                const { a, b } = ipc.port();

                expect(a).toBeDefined();
                expect(b).toBeDefined();
            });

            it('should allow message passing', async () => {
                const { a, b } = ipc.port();

                const received: unknown[] = [];

                b.onmessage = event => {
                    received.push(event.data);
                };

                b.start();

                a.postMessage('hello');

                // Allow message to propagate
                await Bun.sleep(10);

                expect(received).toContain('hello');

                a.close();
                b.close();
            });
        });

        describe('mutex (mock)', () => {
            it('should start unlocked', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                expect(mutex.locked).toBe(false);
            });

            it('should lock on first trylock', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                expect(mutex.trylock()).toBe(true);
                expect(mutex.locked).toBe(true);
            });

            it('should fail trylock when already locked', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                mutex.trylock();
                expect(mutex.trylock()).toBe(false);
            });

            it('should unlock', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                mutex.trylock();
                mutex.unlock();
                expect(mutex.locked).toBe(false);
            });

            it('should throw on blocking lock when already locked', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                mutex.trylock();
                expect(() => mutex.lock()).toThrow('would block');
            });
        });

        describe('semaphore (mock)', () => {
            it('should start with initial value', () => {
                const buf = ipc.alloc(64);
                const sem = ipc.semaphore(buf, 0, 3);

                expect(sem.value()).toBe(3);
            });

            it('should decrement on trywait', () => {
                const buf = ipc.alloc(64);
                const sem = ipc.semaphore(buf, 0, 3);

                expect(sem.trywait()).toBe(true);
                expect(sem.value()).toBe(2);
            });

            it('should fail trywait when zero', () => {
                const buf = ipc.alloc(64);
                const sem = ipc.semaphore(buf, 0, 0);

                expect(sem.trywait()).toBe(false);
            });

            it('should increment on post', () => {
                const buf = ipc.alloc(64);
                const sem = ipc.semaphore(buf, 0, 0);

                sem.post();
                expect(sem.value()).toBe(1);
            });

            it('should throw on blocking wait when zero', () => {
                const buf = ipc.alloc(64);
                const sem = ipc.semaphore(buf, 0, 0);

                expect(() => sem.wait()).toThrow('would block');
            });
        });

        describe('condvar (mock)', () => {
            it('should throw on wait (would block)', () => {
                const buf = ipc.alloc(64);
                const cv = ipc.condvar(buf, 0);
                const mutex = ipc.mutex(buf, 4);

                expect(() => cv.wait(mutex)).toThrow('would block');
            });

            it('should return false on timedwait (timeout)', () => {
                const buf = ipc.alloc(64);
                const cv = ipc.condvar(buf, 0);
                const mutex = ipc.mutex(buf, 4);

                expect(cv.timedwait(mutex, 100)).toBe(false);
            });

            it('should not throw on signal/broadcast', () => {
                const buf = ipc.alloc(64);
                const cv = ipc.condvar(buf, 0);

                cv.signal();
                cv.broadcast();
            });
        });
    });

    describe('BunIPCDevice', () => {
        let ipc: BunIPCDevice;

        beforeEach(() => {
            ipc = new BunIPCDevice();
        });

        describe('alloc', () => {
            it('should allocate SharedArrayBuffer', () => {
                const buf = ipc.alloc(1024);

                expect(buf).toBeInstanceOf(SharedArrayBuffer);
                expect(buf.byteLength).toBe(1024);
            });
        });

        describe('port', () => {
            it('should create MessageChannel', () => {
                const { a, b } = ipc.port();

                expect(a).toBeDefined();
                expect(b).toBeDefined();
            });
        });

        describe('mutex', () => {
            it('should require 4-byte alignment', () => {
                const buf = ipc.alloc(64);

                expect(() => ipc.mutex(buf, 1)).toThrow('4-byte aligned');
            });

            it('should start unlocked', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                expect(mutex.locked).toBe(false);
            });

            it('should lock with trylock', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                expect(mutex.trylock()).toBe(true);
                expect(mutex.locked).toBe(true);
            });

            it('should fail trylock when locked', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                mutex.trylock();
                expect(mutex.trylock()).toBe(false);
            });

            it('should unlock', () => {
                const buf = ipc.alloc(64);
                const mutex = ipc.mutex(buf, 0);

                mutex.trylock();
                mutex.unlock();
                expect(mutex.locked).toBe(false);
                expect(mutex.trylock()).toBe(true);
            });

            // Note: lock() with blocking cannot be easily tested in main thread
            // as Atomics.wait() throws
        });

        describe('semaphore', () => {
            it('should require 4-byte alignment', () => {
                const buf = ipc.alloc(64);

                expect(() => ipc.semaphore(buf, 3, 1)).toThrow('4-byte aligned');
            });

            it('should reject negative initial value', () => {
                const buf = ipc.alloc(64);

                expect(() => ipc.semaphore(buf, 0, -1)).toThrow('non-negative');
            });

            it('should track value correctly', () => {
                const buf = ipc.alloc(64);
                const sem = ipc.semaphore(buf, 0, 5);

                expect(sem.value()).toBe(5);

                sem.trywait();
                expect(sem.value()).toBe(4);

                sem.post();
                expect(sem.value()).toBe(5);
            });

            it('should fail trywait at zero', () => {
                const buf = ipc.alloc(64);
                const sem = ipc.semaphore(buf, 0, 0);

                expect(sem.trywait()).toBe(false);
            });
        });

        describe('condvar', () => {
            it('should require 4-byte alignment', () => {
                const buf = ipc.alloc(64);

                expect(() => ipc.condvar(buf, 2)).toThrow('4-byte aligned');
            });

            it('should not throw on signal/broadcast', () => {
                const buf = ipc.alloc(64);
                const cv = ipc.condvar(buf, 0);

                cv.signal();
                cv.broadcast();
            });

            // Note: wait() tests require Worker threads
        });
    });
});
