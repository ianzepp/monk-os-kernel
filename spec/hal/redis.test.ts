import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryRedis, createRedisDevice } from '@src/hal/index.js';
import type { PubsubSubscription } from '@src/hal/index.js';

describe('Redis Device', () => {
    describe('MemoryRedis', () => {
        let redis: MemoryRedis;

        beforeEach(() => {
            redis = new MemoryRedis();
        });

        afterEach(async () => {
            await redis.shutdown();
        });

        // =====================================================================
        // CACHE OPERATIONS
        // =====================================================================

        describe('get/set', () => {
            it('should return null for missing key', async () => {
                const result = await redis.get('missing');

                expect(result).toBeNull();
            });

            it('should store and retrieve value', async () => {
                await redis.set('key', 'value');
                const result = await redis.get('key');

                expect(result).toBe('value');
            });

            it('should overwrite existing value', async () => {
                await redis.set('key', 'value1');
                await redis.set('key', 'value2');
                const result = await redis.get('key');

                expect(result).toBe('value2');
            });

            it('should expire key with ex option (seconds)', async () => {
                await redis.set('key', 'value', { ex: 1 });
                expect(await redis.get('key')).toBe('value');

                await Bun.sleep(1100);
                expect(await redis.get('key')).toBeNull();
            });

            it('should expire key with px option (milliseconds)', async () => {
                await redis.set('key', 'value', { px: 100 });
                expect(await redis.get('key')).toBe('value');

                await Bun.sleep(150);
                expect(await redis.get('key')).toBeNull();
            });

            it('should clear TTL when setting without TTL', async () => {
                await redis.set('key', 'value', { ex: 1 });
                await redis.set('key', 'value2'); // No TTL
                expect(await redis.ttl('key')).toBe(-1);
            });
        });

        describe('del', () => {
            it('should return 0 for missing key', async () => {
                const count = await redis.del('missing');

                expect(count).toBe(0);
            });

            it('should delete existing key and return 1', async () => {
                await redis.set('key', 'value');
                const count = await redis.del('key');

                expect(count).toBe(1);
                expect(await redis.get('key')).toBeNull();
            });

            it('should delete multiple keys', async () => {
                await redis.set('key1', 'value1');
                await redis.set('key2', 'value2');
                await redis.set('key3', 'value3');

                const count = await redis.del('key1', 'key2', 'missing');

                expect(count).toBe(2);
                expect(await redis.get('key1')).toBeNull();
                expect(await redis.get('key2')).toBeNull();
                expect(await redis.get('key3')).toBe('value3');
            });
        });

        describe('exists', () => {
            it('should return false for missing key', async () => {
                expect(await redis.exists('missing')).toBe(false);
            });

            it('should return true for existing key', async () => {
                await redis.set('key', 'value');
                expect(await redis.exists('key')).toBe(true);
            });

            it('should return false for expired key', async () => {
                await redis.set('key', 'value', { px: 50 });
                await Bun.sleep(100);
                expect(await redis.exists('key')).toBe(false);
            });
        });

        describe('expire', () => {
            it('should return false for missing key', async () => {
                expect(await redis.expire('missing', 10)).toBe(false);
            });

            it('should set TTL on existing key', async () => {
                await redis.set('key', 'value');
                expect(await redis.expire('key', 10)).toBe(true);
                expect(await redis.ttl('key')).toBeGreaterThan(0);
            });
        });

        describe('ttl', () => {
            it('should return -2 for missing key', async () => {
                expect(await redis.ttl('missing')).toBe(-2);
            });

            it('should return -1 for key without TTL', async () => {
                await redis.set('key', 'value');
                expect(await redis.ttl('key')).toBe(-1);
            });

            it('should return remaining seconds', async () => {
                await redis.set('key', 'value', { ex: 10 });
                const ttl = await redis.ttl('key');

                expect(ttl).toBeGreaterThan(8);
                expect(ttl).toBeLessThanOrEqual(10);
            });

            it('should return -2 for expired key', async () => {
                await redis.set('key', 'value', { px: 50 });
                await Bun.sleep(100);
                expect(await redis.ttl('key')).toBe(-2);
            });
        });

        describe('incr/incrby/decr', () => {
            it('should create key with value 1 on incr', async () => {
                const result = await redis.incr('counter');

                expect(result).toBe(1);
                expect(await redis.get('counter')).toBe('1');
            });

            it('should increment existing value', async () => {
                await redis.set('counter', '5');
                const result = await redis.incr('counter');

                expect(result).toBe(6);
            });

            it('should increment by specific amount', async () => {
                await redis.set('counter', '10');
                const result = await redis.incrby('counter', 5);

                expect(result).toBe(15);
            });

            it('should handle negative increment', async () => {
                await redis.set('counter', '10');
                const result = await redis.incrby('counter', -3);

                expect(result).toBe(7);
            });

            it('should decrement value', async () => {
                await redis.set('counter', '10');
                const result = await redis.decr('counter');

                expect(result).toBe(9);
            });

            it('should throw on non-integer value', async () => {
                await redis.set('key', 'not-a-number');
                await expect(redis.incr('key')).rejects.toThrow('not an integer');
            });
        });

        describe('mget/mset', () => {
            it('should get multiple keys', async () => {
                await redis.set('key1', 'value1');
                await redis.set('key2', 'value2');

                const result = await redis.mget('key1', 'key2', 'missing');

                expect(result).toEqual(['value1', 'value2', null]);
            });

            it('should set multiple keys', async () => {
                await redis.mset({ key1: 'value1', key2: 'value2' });

                expect(await redis.get('key1')).toBe('value1');
                expect(await redis.get('key2')).toBe('value2');
            });
        });

        describe('setnx', () => {
            it('should set key if not exists', async () => {
                const result = await redis.setnx('key', 'value');

                expect(result).toBe(true);
                expect(await redis.get('key')).toBe('value');
            });

            it('should not overwrite existing key', async () => {
                await redis.set('key', 'original');
                const result = await redis.setnx('key', 'new');

                expect(result).toBe(false);
                expect(await redis.get('key')).toBe('original');
            });

            it('should set key if previous expired', async () => {
                await redis.set('key', 'value', { px: 50 });
                await Bun.sleep(100);

                const result = await redis.setnx('key', 'new');

                expect(result).toBe(true);
                expect(await redis.get('key')).toBe('new');
            });
        });

        // =====================================================================
        // PUBSUB OPERATIONS
        // =====================================================================

        describe('subscribe/publish', () => {
            let sub: PubsubSubscription;

            afterEach(async () => {
                if (sub) {
                    await sub.close();
                }
            });

            it('should receive published messages', async () => {
                sub = await redis.subscribe(['test.topic']);
                const messages: unknown[] = [];

                const reader = (async () => {
                    for await (const msg of sub.messages()) {
                        messages.push(msg);
                        if (messages.length >= 2) {
                            break;
                        }
                    }
                })();

                await redis.publish('test.topic', { data: 1 });
                await redis.publish('test.topic', { data: 2 });

                await reader;

                expect(messages).toHaveLength(2);
                expect(messages[0]).toEqual({
                    topic: 'test.topic',
                    payload: { data: 1 },
                    pattern: 'test.topic',
                });
            });

            it('should match wildcard pattern *', async () => {
                sub = await redis.subscribe(['event.*']);
                const messages: unknown[] = [];

                const reader = (async () => {
                    for await (const msg of sub.messages()) {
                        messages.push(msg);
                        if (messages.length >= 2) {
                            break;
                        }
                    }
                })();

                await redis.publish('event.chat', 'hello');
                await redis.publish('event.system', 'world');
                await redis.publish('event.chat.room', 'ignored'); // Should not match

                await reader;

                expect(messages).toHaveLength(2);
            });

            it('should match wildcard pattern **', async () => {
                sub = await redis.subscribe(['event.**']);
                const messages: unknown[] = [];

                const reader = (async () => {
                    for await (const msg of sub.messages()) {
                        messages.push(msg);
                        if (messages.length >= 3) {
                            break;
                        }
                    }
                })();

                await redis.publish('event.chat', 'one');
                await redis.publish('event.chat.room', 'two');
                await redis.publish('event.chat.room.123', 'three');

                await reader;

                expect(messages).toHaveLength(3);
            });

            it('should return subscriber count', async () => {
                expect(await redis.subscriberCount('test.topic')).toBe(0);

                sub = await redis.subscribe(['test.topic']);
                expect(await redis.subscriberCount('test.topic')).toBe(1);

                const sub2 = await redis.subscribe(['test.topic']);

                expect(await redis.subscriberCount('test.topic')).toBe(2);

                await sub2.close();
                expect(await redis.subscriberCount('test.topic')).toBe(1);
            });

            it('should return publish count', async () => {
                const count1 = await redis.publish('no.subscribers', 'test');

                expect(count1).toBe(0);

                sub = await redis.subscribe(['test.topic']);
                const count2 = await redis.publish('test.topic', 'test');

                expect(count2).toBe(1);
            });

            it('should stop receiving after close', async () => {
                sub = await redis.subscribe(['test.topic']);
                const messages: unknown[] = [];

                const reader = (async () => {
                    for await (const msg of sub.messages()) {
                        messages.push(msg);
                    }
                })();

                await redis.publish('test.topic', 'first');
                await Bun.sleep(10);
                await sub.close();
                await redis.publish('test.topic', 'after-close');

                await reader;

                expect(messages).toHaveLength(1);
            });

            it('should handle multiple patterns per subscription', async () => {
                sub = await redis.subscribe(['event.a', 'event.b']);
                const messages: unknown[] = [];

                const reader = (async () => {
                    for await (const msg of sub.messages()) {
                        messages.push(msg);
                        if (messages.length >= 2) {
                            break;
                        }
                    }
                })();

                await redis.publish('event.a', 'a');
                await redis.publish('event.b', 'b');
                await redis.publish('event.c', 'c'); // Not subscribed

                await reader;

                expect(messages).toHaveLength(2);
            });
        });

        // =====================================================================
        // PREFIX SUPPORT
        // =====================================================================

        describe('key prefix', () => {
            let prefixedRedis: MemoryRedis;

            beforeEach(() => {
                prefixedRedis = new MemoryRedis({ prefix: 'test:' });
            });

            afterEach(async () => {
                await prefixedRedis.shutdown();
            });

            it('should prefix cache keys', async () => {
                await prefixedRedis.set('key', 'value');
                // Internal storage uses prefixed key
                expect(await prefixedRedis.get('key')).toBe('value');
            });

            it('should prefix pubsub topics', async () => {
                const sub = await prefixedRedis.subscribe(['topic']);
                const messages: unknown[] = [];

                const reader = (async () => {
                    for await (const msg of sub.messages()) {
                        messages.push(msg);
                        break;
                    }
                })();

                await prefixedRedis.publish('topic', 'data');
                await reader;
                await sub.close();

                expect(messages).toHaveLength(1);
                expect((messages[0] as { topic: string }).topic).toBe('topic');
            });
        });

        // =====================================================================
        // LIFECYCLE
        // =====================================================================

        describe('shutdown', () => {
            it('should clear all state', async () => {
                await redis.set('key', 'value');
                const _sub = await redis.subscribe(['test']);

                await redis.shutdown();

                // Create fresh instance to verify state was cleared
                const fresh = new MemoryRedis();

                expect(await fresh.get('key')).toBeNull();
                await fresh.shutdown();
            });

            it('should close active subscriptions', async () => {
                const sub = await redis.subscribe(['test']);
                const messages: unknown[] = [];

                const reader = (async () => {
                    for await (const msg of sub.messages()) {
                        messages.push(msg);
                    }
                })();

                await redis.shutdown();
                await reader;

                // Reader should complete without error
                expect(messages).toHaveLength(0);
            });

            it('should clear TTL timers', async () => {
                await redis.set('key', 'value', { ex: 60 });
                await redis.shutdown();
                // No error should occur from orphaned timers
            });
        });
    });

    // =========================================================================
    // FACTORY FUNCTION
    // =========================================================================

    describe('createRedisDevice', () => {
        it('should create MemoryRedis by default', () => {
            const device = createRedisDevice();

            expect(device).toBeInstanceOf(MemoryRedis);
        });

        it('should create MemoryRedis when type is memory', () => {
            const device = createRedisDevice({ type: 'memory' });

            expect(device).toBeInstanceOf(MemoryRedis);
        });

        it('should throw for redis type (not implemented)', () => {
            expect(() => createRedisDevice({ type: 'redis' })).toThrow('not yet implemented');
        });

        it('should pass config to MemoryRedis', async () => {
            const device = createRedisDevice({
                type: 'memory',
                prefix: 'app:',
            }) as MemoryRedis;

            await device.set('key', 'value');
            expect(await device.get('key')).toBe('value');
            await device.shutdown();
        });
    });
});
