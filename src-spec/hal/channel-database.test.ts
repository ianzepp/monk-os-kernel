import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunChannelDevice } from '@src/hal/channel.js';
import type { Channel } from '@src/hal/channel.js';
import { collectItems } from '@src/message.js';

describe('Database Channels', () => {
    describe('SQLite Channel', () => {
        let device: BunChannelDevice;
        let channel: Channel;

        beforeEach(async () => {
            device = new BunChannelDevice();
            channel = await device.open('sqlite', ':memory:');
        });

        afterEach(async () => {
            await channel.close();
        });

        describe('query op', () => {
            it('should return empty result for table with no rows', async () => {
                // Create table
                const createResponses: unknown[] = [];
                for await (const r of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)' },
                })) {
                    createResponses.push(r);
                }
                expect(createResponses[0]).toHaveProperty('op', 'ok');

                // Query empty table
                const rows = await collectItems(
                    channel.handle({
                        op: 'query',
                        data: { sql: 'SELECT * FROM test' },
                    })
                );
                expect(rows).toEqual([]);
            });

            it('should stream rows as item responses', async () => {
                // Create and populate table
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)' },
                })) {
                    // consume
                }

                for await (const _ of channel.handle({
                    op: 'execute',
                    data: {
                        sql: 'INSERT INTO users (name) VALUES (?), (?), (?)',
                        params: ['Alice', 'Bob', 'Carol'],
                    },
                })) {
                    // consume
                }

                // Query
                const rows = await collectItems<{ id: number; name: string }>(
                    channel.handle({
                        op: 'query',
                        data: { sql: 'SELECT * FROM users ORDER BY id' },
                    })
                );

                expect(rows).toHaveLength(3);
                expect(rows[0].name).toBe('Alice');
                expect(rows[1].name).toBe('Bob');
                expect(rows[2].name).toBe('Carol');
            });

            it('should support parameter binding', async () => {
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, value INTEGER)' },
                })) {
                    // consume
                }

                for await (const _ of channel.handle({
                    op: 'execute',
                    data: {
                        sql: 'INSERT INTO items (value) VALUES (?), (?), (?)',
                        params: [10, 20, 30],
                    },
                })) {
                    // consume
                }

                const rows = await collectItems<{ id: number; value: number }>(
                    channel.handle({
                        op: 'query',
                        data: { sql: 'SELECT * FROM items WHERE value > ?', params: [15] },
                    })
                );

                expect(rows).toHaveLength(2);
                expect(rows.map((r) => r.value).sort()).toEqual([20, 30]);
            });

            it('should return error for invalid SQL', async () => {
                const responses: unknown[] = [];
                for await (const r of channel.handle({
                    op: 'query',
                    data: { sql: 'SELECT * FROM nonexistent_table' },
                })) {
                    responses.push(r);
                }

                expect(responses).toHaveLength(1);
                expect(responses[0]).toHaveProperty('op', 'error');
                expect(responses[0]).toHaveProperty('data.code', 'EIO');
            });
        });

        describe('execute op', () => {
            it('should return affected row count for INSERT', async () => {
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)' },
                })) {
                    // consume
                }

                const responses: unknown[] = [];
                for await (const r of channel.handle({
                    op: 'execute',
                    data: {
                        sql: 'INSERT INTO test (name) VALUES (?), (?)',
                        params: ['a', 'b'],
                    },
                })) {
                    responses.push(r);
                }

                expect(responses).toHaveLength(1);
                expect(responses[0]).toHaveProperty('op', 'ok');
                expect(responses[0]).toHaveProperty('data.affectedRows', 2);
            });

            it('should return affected row count for UPDATE', async () => {
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY, active INTEGER)' },
                })) {
                    // consume
                }

                for await (const _ of channel.handle({
                    op: 'execute',
                    data: {
                        sql: 'INSERT INTO test (active) VALUES (1), (1), (0)',
                    },
                })) {
                    // consume
                }

                const responses: unknown[] = [];
                for await (const r of channel.handle({
                    op: 'execute',
                    data: {
                        sql: 'UPDATE test SET active = 0 WHERE active = 1',
                    },
                })) {
                    responses.push(r);
                }

                expect(responses[0]).toHaveProperty('data.affectedRows', 2);
            });

            it('should return affected row count for DELETE', async () => {
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY)' },
                })) {
                    // consume
                }

                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'INSERT INTO test (id) VALUES (1), (2), (3)' },
                })) {
                    // consume
                }

                const responses: unknown[] = [];
                for await (const r of channel.handle({
                    op: 'execute',
                    data: { sql: 'DELETE FROM test WHERE id > 1' },
                })) {
                    responses.push(r);
                }

                expect(responses[0]).toHaveProperty('data.affectedRows', 2);
            });
        });

        describe('channel state', () => {
            it('should report closed status', async () => {
                expect(channel.closed).toBe(false);
                await channel.close();
                expect(channel.closed).toBe(true);
            });

            it('should return error when used after close', async () => {
                await channel.close();

                const responses: unknown[] = [];
                for await (const r of channel.handle({
                    op: 'query',
                    data: { sql: 'SELECT 1' },
                })) {
                    responses.push(r);
                }

                expect(responses[0]).toHaveProperty('op', 'error');
                expect(responses[0]).toHaveProperty('data.code', 'EBADF');
            });
        });

        describe('unknown op', () => {
            it('should return error for unknown op', async () => {
                const responses: unknown[] = [];
                for await (const r of channel.handle({
                    op: 'unknown',
                    data: {},
                })) {
                    responses.push(r);
                }

                expect(responses[0]).toHaveProperty('op', 'error');
                expect(responses[0]).toHaveProperty('data.code', 'EINVAL');
            });
        });

        describe('transactions via SQL', () => {
            it('should support explicit transactions', async () => {
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER)' },
                })) {
                    // consume
                }

                // Begin transaction
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'BEGIN' },
                })) {
                    // consume
                }

                // Insert
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'INSERT INTO test (value) VALUES (100)' },
                })) {
                    // consume
                }

                // Commit
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'COMMIT' },
                })) {
                    // consume
                }

                // Verify
                const rows = await collectItems<{ value: number }>(
                    channel.handle({
                        op: 'query',
                        data: { sql: 'SELECT value FROM test' },
                    })
                );

                expect(rows).toHaveLength(1);
                expect(rows[0].value).toBe(100);
            });

            it('should support rollback', async () => {
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER)' },
                })) {
                    // consume
                }

                // Insert initial value
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'INSERT INTO test (value) VALUES (1)' },
                })) {
                    // consume
                }

                // Begin transaction
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'BEGIN' },
                })) {
                    // consume
                }

                // Update value
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'UPDATE test SET value = 999' },
                })) {
                    // consume
                }

                // Rollback
                for await (const _ of channel.handle({
                    op: 'execute',
                    data: { sql: 'ROLLBACK' },
                })) {
                    // consume
                }

                // Verify original value preserved
                const rows = await collectItems<{ value: number }>(
                    channel.handle({
                        op: 'query',
                        data: { sql: 'SELECT value FROM test' },
                    })
                );

                expect(rows).toHaveLength(1);
                expect(rows[0].value).toBe(1);
            });
        });

        describe('channel metadata', () => {
            it('should have correct protocol', () => {
                expect(channel.proto).toBe('sqlite');
            });

            it('should have description matching path', () => {
                expect(channel.description).toBe(':memory:');
            });

            it('should have unique id', () => {
                expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
            });
        });

        describe('push/recv not supported', () => {
            it('should throw on push', async () => {
                await expect(channel.push({ op: 'ok' })).rejects.toThrow(
                    'SQLite channels do not support push'
                );
            });

            it('should throw on recv', async () => {
                await expect(channel.recv()).rejects.toThrow(
                    'SQLite channels do not support recv'
                );
            });
        });
    });

    describe('BunChannelDevice', () => {
        it('should open sqlite channels', async () => {
            const device = new BunChannelDevice();
            const channel = await device.open('sqlite', ':memory:');

            expect(channel.proto).toBe('sqlite');
            await channel.close();
        });

        it('should open postgres channels (requires database)', async () => {
            const device = new BunChannelDevice();

            // This test just verifies the channel can be created
            // Actual connection requires a running PostgreSQL instance
            const channel = await device.open('postgres', 'postgresql://localhost/test');
            expect(channel.proto).toBe('postgres');

            // Close immediately (connection will fail without database)
            await channel.close();
        });

        it('should throw for unsupported protocol', async () => {
            const device = new BunChannelDevice();
            await expect(device.open('redis', 'redis://localhost')).rejects.toThrow(
                'Unsupported protocol: redis'
            );
        });
    });
});
