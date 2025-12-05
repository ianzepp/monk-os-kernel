import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryBlockDevice, BunBlockDevice } from '@src/hal/index.js';
import { unlink } from 'node:fs/promises';

describe('Block Device', () => {
    describe('MemoryBlockDevice', () => {
        let block: MemoryBlockDevice;

        beforeEach(() => {
            block = new MemoryBlockDevice(4096);
        });

        describe('read', () => {
            it('should return zeros for unwritten data', async () => {
                const data = await block.read(0, 100);

                expect(data.length).toBe(100);
                expect(data.every(b => b === 0)).toBe(true);
            });

            it('should return empty at end of buffer', async () => {
                const stat = await block.stat();
                const data = await block.read(stat.size, 100);

                expect(data.length).toBe(0);
            });

            it('should clamp to buffer bounds', async () => {
                const stat = await block.stat();
                const data = await block.read(stat.size - 10, 100);

                expect(data.length).toBe(10);
            });
        });

        describe('write', () => {
            it('should write data at offset', async () => {
                const data = new Uint8Array([1, 2, 3, 4, 5]);

                await block.write(100, data);

                const result = await block.read(100, 5);

                expect(result).toEqual(data);
            });

            it('should grow buffer when writing past end', async () => {
                const stat1 = await block.stat();
                const initialSize = stat1.size;

                const data = new Uint8Array([1, 2, 3, 4, 5]);

                await block.write(initialSize + 100, data);

                const stat2 = await block.stat();

                expect(stat2.size).toBeGreaterThan(initialSize);

                const result = await block.read(initialSize + 100, 5);

                expect(result).toEqual(data);
            });

            it('should preserve adjacent data', async () => {
                const data1 = new Uint8Array([1, 2, 3]);
                const data2 = new Uint8Array([4, 5, 6]);

                await block.write(0, data1);
                await block.write(10, data2);

                expect(await block.read(0, 3)).toEqual(data1);
                expect(await block.read(10, 3)).toEqual(data2);
            });
        });

        describe('sync', () => {
            it('should complete without error', async () => {
                await block.sync();
            });
        });

        describe('stat', () => {
            it('should return correct initial size', async () => {
                const stat = await block.stat();

                expect(stat.size).toBe(4096);
                expect(stat.blocksize).toBe(4096);
                expect(stat.readonly).toBe(false);
            });
        });

        describe('writelock', () => {
            it('should return lock with correct offset and size', async () => {
                const lock = await block.writelock(0, 100);

                expect(lock.offset).toBe(0);
                expect(lock.size).toBe(100);
                lock.release();
            });

            it('should be releasable', async () => {
                const lock = await block.writelock(0, 100);

                lock.release();
                // Should be able to acquire again
                const lock2 = await block.writelock(0, 100);

                lock2.release();
            });

            it('should support Symbol.dispose', async () => {
                const lock = await block.writelock(0, 100);

                expect(lock[Symbol.dispose]).toBeDefined();
                lock[Symbol.dispose]();
            });

            it('should block overlapping locks', async () => {
                const lock1 = await block.writelock(0, 100);

                let acquired = false;
                const lock2Promise = block.writelock(50, 100).then(lock => {
                    acquired = true;

                    return lock;
                });

                // Should not acquire immediately
                await Bun.sleep(10);
                expect(acquired).toBe(false);

                lock1.release();
                const lock2 = await lock2Promise;

                expect(acquired).toBe(true);
                lock2.release();
            });

            it('should allow non-overlapping locks', async () => {
                const lock1 = await block.writelock(0, 100);
                const lock2 = await block.writelock(200, 100);

                lock1.release();
                lock2.release();
            });
        });

        describe('reset', () => {
            it('should clear data', async () => {
                await block.write(0, new Uint8Array([1, 2, 3, 4, 5]));
                block.reset();

                const data = await block.read(0, 5);

                expect(data.every(b => b === 0)).toBe(true);
            });
        });
    });

    describe('BunBlockDevice', () => {
        const testPath = '/tmp/hal-block-test-' + Date.now() + '.bin';
        let block: BunBlockDevice;

        beforeEach(async () => {
            block = new BunBlockDevice(testPath);
            // Ensure clean state
            try {
                await unlink(testPath);
            }
            catch {
                // File may not exist
            }
        });

        afterEach(async () => {
            try {
                await unlink(testPath);
            }
            catch {
                // Ignore cleanup errors
            }
        });

        describe('read', () => {
            it('should return empty for non-existent file', async () => {
                const data = await block.read(0, 100);

                expect(data.length).toBe(0);
            });

            it('should return written data', async () => {
                const input = new Uint8Array([1, 2, 3, 4, 5]);

                await block.write(0, input);

                const data = await block.read(0, 5);

                expect(data).toEqual(input);
            });

            it('should return empty past end of file', async () => {
                await block.write(0, new Uint8Array([1, 2, 3]));
                const data = await block.read(100, 10);

                expect(data.length).toBe(0);
            });
        });

        describe('write', () => {
            it('should create file on first write', async () => {
                await block.write(0, new Uint8Array([1, 2, 3]));
                const stat = await block.stat();

                expect(stat.size).toBe(3);
            });

            it('should write at offset', async () => {
                await block.write(0, new Uint8Array([1, 2, 3]));
                await block.write(10, new Uint8Array([4, 5, 6]));

                expect(await block.read(0, 3)).toEqual(new Uint8Array([1, 2, 3]));
                expect(await block.read(10, 3)).toEqual(new Uint8Array([4, 5, 6]));
            });

            it('should extend file with zeros', async () => {
                await block.write(10, new Uint8Array([1, 2, 3]));
                const data = await block.read(0, 10);

                expect(data.every(b => b === 0)).toBe(true);
            });
        });

        describe('stat', () => {
            it('should return size 0 for non-existent file', async () => {
                const stat = await block.stat();

                expect(stat.size).toBe(0);
            });

            it('should return correct size after write', async () => {
                await block.write(0, new Uint8Array(100));
                const stat = await block.stat();

                expect(stat.size).toBe(100);
            });

            it('should have blocksize 4096', async () => {
                const stat = await block.stat();

                expect(stat.blocksize).toBe(4096);
            });

            it('should not be readonly', async () => {
                const stat = await block.stat();

                expect(stat.readonly).toBe(false);
            });
        });

        describe('writelock', () => {
            it('should work same as MemoryBlockDevice', async () => {
                const lock = await block.writelock(0, 100);

                expect(lock.offset).toBe(0);
                expect(lock.size).toBe(100);
                lock.release();
            });
        });
    });
});
