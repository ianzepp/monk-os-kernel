import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { MemoryStorageEngine, BunStorageEngine, PostgresStorageEngine } from '@src/hal/index.js';
import { unlink } from 'node:fs/promises';

describe('Storage Engine', () => {
    describe('MemoryStorageEngine', () => {
        let storage: MemoryStorageEngine;

        beforeEach(() => {
            storage = new MemoryStorageEngine();
        });

        afterEach(async () => {
            await storage.close();
        });

        describe('get/put', () => {
            it('should return null for missing key', async () => {
                const value = await storage.get('missing');
                expect(value).toBeNull();
            });

            it('should store and retrieve value', async () => {
                const data = new Uint8Array([1, 2, 3, 4, 5]);
                await storage.put('key1', data);

                const result = await storage.get('key1');
                expect(result).toEqual(data);
            });

            it('should overwrite existing value', async () => {
                await storage.put('key1', new Uint8Array([1, 2, 3]));
                await storage.put('key1', new Uint8Array([4, 5, 6]));

                const result = await storage.get('key1');
                expect(result).toEqual(new Uint8Array([4, 5, 6]));
            });

            it('should handle empty value', async () => {
                await storage.put('empty', new Uint8Array(0));
                const result = await storage.get('empty');
                expect(result).toEqual(new Uint8Array(0));
            });

            it('should handle binary data', async () => {
                const data = new Uint8Array(256);
                for (let i = 0; i < 256; i++) {
                    data[i] = i;
                }
                await storage.put('binary', data);
                expect(await storage.get('binary')).toEqual(data);
            });
        });

        describe('delete', () => {
            it('should remove key', async () => {
                await storage.put('key1', new Uint8Array([1, 2, 3]));
                await storage.delete('key1');
                expect(await storage.get('key1')).toBeNull();
            });

            it('should not throw for missing key', async () => {
                await storage.delete('missing');
            });
        });

        describe('exists', () => {
            it('should return false for missing key', async () => {
                expect(await storage.exists('missing')).toBe(false);
            });

            it('should return true for existing key', async () => {
                await storage.put('key1', new Uint8Array([1]));
                expect(await storage.exists('key1')).toBe(true);
            });
        });

        describe('stat', () => {
            it('should return null for missing key', async () => {
                expect(await storage.stat('missing')).toBeNull();
            });

            it('should return size and mtime', async () => {
                const before = Date.now();
                await storage.put('key1', new Uint8Array(100));
                const after = Date.now();

                const stat = await storage.stat('key1');
                expect(stat).not.toBeNull();
                expect(stat!.size).toBe(100);
                expect(stat!.mtime).toBeGreaterThanOrEqual(before);
                expect(stat!.mtime).toBeLessThanOrEqual(after);
            });
        });

        describe('list', () => {
            it('should return empty for no matches', async () => {
                const keys: string[] = [];
                for await (const key of storage.list('prefix:')) {
                    keys.push(key);
                }
                expect(keys).toEqual([]);
            });

            it('should return matching keys', async () => {
                await storage.put('prefix:a', new Uint8Array([1]));
                await storage.put('prefix:b', new Uint8Array([2]));
                await storage.put('other:c', new Uint8Array([3]));

                const keys: string[] = [];
                for await (const key of storage.list('prefix:')) {
                    keys.push(key);
                }

                expect(keys.sort()).toEqual(['prefix:a', 'prefix:b']);
            });

            it('should return all keys with empty prefix', async () => {
                await storage.put('a', new Uint8Array([1]));
                await storage.put('b', new Uint8Array([2]));

                const keys: string[] = [];
                for await (const key of storage.list('')) {
                    keys.push(key);
                }

                expect(keys.sort()).toEqual(['a', 'b']);
            });
        });

        describe('transaction', () => {
            it('should commit changes', async () => {
                const tx = await storage.begin();
                await tx.put('key1', new Uint8Array([1, 2, 3]));
                await tx.commit();

                expect(await storage.get('key1')).toEqual(new Uint8Array([1, 2, 3]));
            });

            it('should rollback changes', async () => {
                await storage.put('key1', new Uint8Array([1, 2, 3]));

                const tx = await storage.begin();
                await tx.put('key1', new Uint8Array([4, 5, 6]));
                await tx.delete('key1');
                await tx.rollback();

                expect(await storage.get('key1')).toEqual(new Uint8Array([1, 2, 3]));
            });

            it('should read uncommitted changes within transaction', async () => {
                const tx = await storage.begin();
                await tx.put('key1', new Uint8Array([1, 2, 3]));

                const value = await tx.get('key1');
                expect(value).toEqual(new Uint8Array([1, 2, 3]));

                await tx.rollback();
            });

            it('should auto-rollback on dispose without commit', async () => {
                await storage.put('key1', new Uint8Array([1]));

                {
                    const tx = await storage.begin();
                    await tx.put('key1', new Uint8Array([2]));
                    await tx[Symbol.asyncDispose]();
                }

                expect(await storage.get('key1')).toEqual(new Uint8Array([1]));
            });
        });

        describe('watch', () => {
            it('should emit put events', async () => {
                const events: Array<{ key: string; op: string }> = [];
                const watchPromise = (async () => {
                    for await (const event of storage.watch('test:*')) {
                        events.push({ key: event.key, op: event.op });
                        if (events.length >= 1) break;
                    }
                })();

                await Bun.sleep(10);
                await storage.put('test:key1', new Uint8Array([1]));

                await watchPromise;
                expect(events.length).toBe(1);
                expect(events[0]!.key).toBe('test:key1');
                expect(events[0]!.op).toBe('put');
            });

            it('should emit delete events', async () => {
                await storage.put('test:key1', new Uint8Array([1]));

                const events: Array<{ key: string; op: string }> = [];
                const watchPromise = (async () => {
                    for await (const event of storage.watch('test:*')) {
                        events.push({ key: event.key, op: event.op });
                        if (events.length >= 1) break;
                    }
                })();

                await Bun.sleep(10);
                await storage.delete('test:key1');

                await watchPromise;
                expect(events[0]!.op).toBe('delete');
            });

            it('should support ** pattern', async () => {
                const events: string[] = [];
                const watchPromise = (async () => {
                    for await (const event of storage.watch('a/**')) {
                        events.push(event.key);
                        if (events.length >= 2) break;
                    }
                })();

                await Bun.sleep(10);
                await storage.put('a/b/c', new Uint8Array([1]));
                await storage.put('a/x', new Uint8Array([2]));

                await watchPromise;
                expect(events).toContain('a/b/c');
                expect(events).toContain('a/x');
            });
        });

        describe('reset', () => {
            it('should clear all data', async () => {
                await storage.put('key1', new Uint8Array([1]));
                await storage.put('key2', new Uint8Array([2]));

                storage.reset();

                expect(await storage.get('key1')).toBeNull();
                expect(await storage.get('key2')).toBeNull();
            });
        });
    });

    describe('BunStorageEngine', () => {
        const testPath = '/tmp/hal-storage-test-' + Date.now() + '.db';
        let storage: BunStorageEngine;

        beforeEach(() => {
            storage = new BunStorageEngine(testPath);
        });

        afterEach(async () => {
            await storage.close();
            try {
                await unlink(testPath);
                await unlink(testPath + '-wal');
                await unlink(testPath + '-shm');
            } catch {
                // Ignore cleanup errors
            }
        });

        describe('get/put', () => {
            it('should store and retrieve value', async () => {
                const data = new Uint8Array([1, 2, 3, 4, 5]);
                await storage.put('key1', data);

                const result = await storage.get('key1');
                expect(result).toEqual(data);
            });

            it('should return null for missing key', async () => {
                expect(await storage.get('missing')).toBeNull();
            });
        });

        describe('delete', () => {
            it('should remove key', async () => {
                await storage.put('key1', new Uint8Array([1]));
                await storage.delete('key1');
                expect(await storage.get('key1')).toBeNull();
            });
        });

        describe('list', () => {
            it('should return keys with prefix', async () => {
                await storage.put('prefix:a', new Uint8Array([1]));
                await storage.put('prefix:b', new Uint8Array([2]));
                await storage.put('other:c', new Uint8Array([3]));

                const keys: string[] = [];
                for await (const key of storage.list('prefix:')) {
                    keys.push(key);
                }

                expect(keys.sort()).toEqual(['prefix:a', 'prefix:b']);
            });
        });

        describe('transaction', () => {
            it('should commit atomically', async () => {
                const tx = await storage.begin();
                await tx.put('tx:a', new Uint8Array([1]));
                await tx.put('tx:b', new Uint8Array([2]));
                await tx.commit();

                expect(await storage.get('tx:a')).toEqual(new Uint8Array([1]));
                expect(await storage.get('tx:b')).toEqual(new Uint8Array([2]));
            });

            it('should rollback on error', async () => {
                await storage.put('key1', new Uint8Array([1]));

                const tx = await storage.begin();
                await tx.put('key1', new Uint8Array([2]));
                await tx.rollback();

                expect(await storage.get('key1')).toEqual(new Uint8Array([1]));
            });
        });

        describe('stat', () => {
            it('should return size and mtime', async () => {
                await storage.put('key1', new Uint8Array(50));
                const stat = await storage.stat('key1');

                expect(stat).not.toBeNull();
                expect(stat!.size).toBe(50);
                expect(typeof stat!.mtime).toBe('number');
            });
        });
    });

    describe('PostgresStorageEngine', () => {
        // Use schema-based isolation for tests
        const testSchema = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const baseUrl = process.env.POSTGRES_URL ?? 'postgresql://localhost/monk_os';
        let storage: PostgresStorageEngine;
        let adminSql: InstanceType<typeof Bun.SQL>;

        beforeAll(async () => {
            // Create test schema
            adminSql = new Bun.SQL(baseUrl);
            await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${testSchema}`);
            await adminSql.unsafe(`SET search_path TO ${testSchema}`);
        });

        afterAll(async () => {
            // Drop test schema
            try {
                await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
                adminSql.close();
            } catch {
                // Ignore cleanup errors
            }
        });

        beforeEach(async () => {
            // Create storage with search_path set to test schema
            storage = new PostgresStorageEngine(`${baseUrl}?options=-c%20search_path%3D${testSchema}`);
            await storage.init();
            // Truncate table to ensure clean state between tests
            await adminSql.unsafe(`TRUNCATE TABLE ${testSchema}.storage`);
        });

        afterEach(async () => {
            // Clean up storage table between tests
            await storage.close();
        });

        describe('get/put', () => {
            it('should store and retrieve value', async () => {
                const data = new Uint8Array([1, 2, 3, 4, 5]);
                await storage.put('key1', data);

                const result = await storage.get('key1');
                expect(result).toEqual(data);
            });

            it('should return null for missing key', async () => {
                expect(await storage.get('missing')).toBeNull();
            });

            it('should overwrite existing value', async () => {
                await storage.put('key1', new Uint8Array([1, 2, 3]));
                await storage.put('key1', new Uint8Array([4, 5, 6]));

                const result = await storage.get('key1');
                expect(result).toEqual(new Uint8Array([4, 5, 6]));
            });

            it('should handle binary data', async () => {
                const data = new Uint8Array(256);
                for (let i = 0; i < 256; i++) {
                    data[i] = i;
                }
                await storage.put('binary', data);
                expect(await storage.get('binary')).toEqual(data);
            });
        });

        describe('delete', () => {
            it('should remove key', async () => {
                await storage.put('key1', new Uint8Array([1]));
                await storage.delete('key1');
                expect(await storage.get('key1')).toBeNull();
            });

            it('should not throw for missing key', async () => {
                await storage.delete('missing');
            });
        });

        describe('exists', () => {
            it('should return false for missing key', async () => {
                expect(await storage.exists('missing')).toBe(false);
            });

            it('should return true for existing key', async () => {
                await storage.put('key1', new Uint8Array([1]));
                expect(await storage.exists('key1')).toBe(true);
            });
        });

        describe('stat', () => {
            it('should return null for missing key', async () => {
                expect(await storage.stat('missing')).toBeNull();
            });

            it('should return size and mtime', async () => {
                const before = Date.now();
                await storage.put('key1', new Uint8Array(100));
                const after = Date.now();

                const stat = await storage.stat('key1');
                expect(stat).not.toBeNull();
                expect(stat!.size).toBe(100);
                expect(stat!.mtime).toBeGreaterThanOrEqual(before);
                expect(stat!.mtime).toBeLessThanOrEqual(after + 1000); // Allow 1s drift
            });
        });

        describe('list', () => {
            it('should return empty for no matches', async () => {
                const keys: string[] = [];
                for await (const key of storage.list('prefix:')) {
                    keys.push(key);
                }
                expect(keys).toEqual([]);
            });

            it('should return matching keys', async () => {
                await storage.put('prefix:a', new Uint8Array([1]));
                await storage.put('prefix:b', new Uint8Array([2]));
                await storage.put('other:c', new Uint8Array([3]));

                const keys: string[] = [];
                for await (const key of storage.list('prefix:')) {
                    keys.push(key);
                }

                expect(keys.sort()).toEqual(['prefix:a', 'prefix:b']);
            });

            it('should return all keys with empty prefix', async () => {
                await storage.put('a', new Uint8Array([1]));
                await storage.put('b', new Uint8Array([2]));

                const keys: string[] = [];
                for await (const key of storage.list('')) {
                    keys.push(key);
                }

                expect(keys.sort()).toEqual(['a', 'b']);
            });
        });

        describe('transaction', () => {
            it('should commit changes', async () => {
                const tx = await storage.begin();
                await tx.put('key1', new Uint8Array([1, 2, 3]));
                await tx.commit();

                expect(await storage.get('key1')).toEqual(new Uint8Array([1, 2, 3]));
            });

            it('should rollback changes', async () => {
                await storage.put('key1', new Uint8Array([1, 2, 3]));

                const tx = await storage.begin();
                await tx.put('key1', new Uint8Array([4, 5, 6]));
                await tx.delete('key1');
                await tx.rollback();

                expect(await storage.get('key1')).toEqual(new Uint8Array([1, 2, 3]));
            });

            it('should read uncommitted changes within transaction', async () => {
                const tx = await storage.begin();
                await tx.put('key1', new Uint8Array([1, 2, 3]));

                const value = await tx.get('key1');
                expect(value).toEqual(new Uint8Array([1, 2, 3]));

                await tx.rollback();
            });

            it('should auto-rollback on dispose without commit', async () => {
                await storage.put('key1', new Uint8Array([1]));

                {
                    const tx = await storage.begin();
                    await tx.put('key1', new Uint8Array([2]));
                    await tx[Symbol.asyncDispose]();
                }

                expect(await storage.get('key1')).toEqual(new Uint8Array([1]));
            });

            it('should commit atomically', async () => {
                const tx = await storage.begin();
                await tx.put('tx:a', new Uint8Array([1]));
                await tx.put('tx:b', new Uint8Array([2]));
                await tx.commit();

                expect(await storage.get('tx:a')).toEqual(new Uint8Array([1]));
                expect(await storage.get('tx:b')).toEqual(new Uint8Array([2]));
            });
        });

        describe('watch', () => {
            it('should emit put events', async () => {
                const events: Array<{ key: string; op: string }> = [];
                const watchPromise = (async () => {
                    for await (const event of storage.watch('test:*')) {
                        events.push({ key: event.key, op: event.op });
                        if (events.length >= 1) break;
                    }
                })();

                await Bun.sleep(10);
                await storage.put('test:key1', new Uint8Array([1]));

                await watchPromise;
                expect(events.length).toBe(1);
                expect(events[0]!.key).toBe('test:key1');
                expect(events[0]!.op).toBe('put');
            });

            it('should emit delete events', async () => {
                await storage.put('test:key1', new Uint8Array([1]));

                const events: Array<{ key: string; op: string }> = [];
                const watchPromise = (async () => {
                    for await (const event of storage.watch('test:*')) {
                        events.push({ key: event.key, op: event.op });
                        if (events.length >= 1) break;
                    }
                })();

                await Bun.sleep(10);
                await storage.delete('test:key1');

                await watchPromise;
                expect(events[0]!.op).toBe('delete');
            });

            it('should support ** pattern', async () => {
                const events: string[] = [];
                const watchPromise = (async () => {
                    for await (const event of storage.watch('a/**')) {
                        events.push(event.key);
                        if (events.length >= 2) break;
                    }
                })();

                await Bun.sleep(10);
                await storage.put('a/b/c', new Uint8Array([1]));
                await storage.put('a/x', new Uint8Array([2]));

                await watchPromise;
                expect(events).toContain('a/b/c');
                expect(events).toContain('a/x');
            });
        });
    });
});
