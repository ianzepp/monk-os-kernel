/**
 * DatabaseOps Tests
 *
 * Tests for the DatabaseOps class which provides generic SQL streaming
 * operations over a DatabaseConnection. DatabaseOps is NOT tied to the
 * EMS observer pipeline - it's a reusable SQL streaming library.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DatabaseOps, collect, type Source, type DbRecord } from '@src/ems/database-ops.js';
import type { DatabaseConnection } from '@src/ems/connection.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

interface SqlCall {
    method: 'query' | 'execute' | 'exec';
    sql: string;
    params?: unknown[];
}

/**
 * Create a mock database connection that tracks calls
 */
function createMockDb(queryResults: Record<string, unknown[][]> = {}): DatabaseConnection & { calls: SqlCall[] } {
    const calls: SqlCall[] = [];
    let queryCounter = 0;

    return {
        calls,
        async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
            calls.push({ method: 'query', sql, params });
            // Return results based on query pattern or empty array
            const results = queryResults[sql] || queryResults['*'] || [];
            const result = results[queryCounter] || [];
            queryCounter++;
            return result as T[];
        },
        async queryOne<T>(_sql: string, _params?: unknown[]): Promise<T | null> {
            return null;
        },
        async execute(sql: string, params?: unknown[]): Promise<number> {
            calls.push({ method: 'execute', sql, params });
            return 1;
        },
        async exec(sql: string): Promise<void> {
            calls.push({ method: 'exec', sql });
        },
        async close(): Promise<void> {},
    };
}

// =============================================================================
// COLLECT HELPER TESTS
// =============================================================================

describe('collect', () => {
    it('should collect async iterable into array', async () => {
        async function* gen(): AsyncGenerator<number> {
            yield 1;
            yield 2;
            yield 3;
        }
        const result = await collect(gen());
        expect(result).toEqual([1, 2, 3]);
    });

    it('should return empty array for empty async iterable', async () => {
        async function* gen(): AsyncGenerator<number> {
            // empty
        }
        const result = await collect(gen());
        expect(result).toEqual([]);
    });
});

// =============================================================================
// DATABASE OPS CONSTRUCTOR TESTS
// =============================================================================

describe('DatabaseOps', () => {
    let mockDb: ReturnType<typeof createMockDb>;
    let dbOps: DatabaseOps;

    beforeEach(() => {
        mockDb = createMockDb();
        dbOps = new DatabaseOps(mockDb);
    });

    describe('constructor', () => {
        it('should create instance with database connection', () => {
            expect(dbOps).toBeInstanceOf(DatabaseOps);
        });

        it('should expose connection via getConnection', () => {
            expect(dbOps.getConnection()).toBe(mockDb);
        });
    });

    // =========================================================================
    // RAW SQL OPERATIONS
    // =========================================================================

    describe('query', () => {
        it('should stream rows from SELECT query', async () => {
            mockDb = createMockDb({
                '*': [[{ id: '1', name: 'A' }, { id: '2', name: 'B' }]],
            });
            dbOps = new DatabaseOps(mockDb);

            const rows = await collect(dbOps.query('SELECT * FROM test'));

            expect(rows).toHaveLength(2);
            expect(rows[0]).toEqual({ id: '1', name: 'A' });
            expect(rows[1]).toEqual({ id: '2', name: 'B' });
        });

        it('should pass parameters to query', async () => {
            mockDb = createMockDb({ '*': [[{ id: '1' }]] });
            dbOps = new DatabaseOps(mockDb);

            await collect(dbOps.query('SELECT * FROM test WHERE id = ?', ['123']));

            expect(mockDb.calls[0].params).toEqual(['123']);
        });

        it('should stream empty result set', async () => {
            mockDb = createMockDb({ '*': [[]] });
            dbOps = new DatabaseOps(mockDb);

            const rows = await collect(dbOps.query('SELECT * FROM empty'));

            expect(rows).toHaveLength(0);
        });
    });

    describe('execute', () => {
        it('should execute SQL and return affected row count', async () => {
            const result = await dbOps.execute('UPDATE test SET name = ?', ['new']);

            expect(result).toBe(1);
            expect(mockDb.calls[0]).toEqual({
                method: 'execute',
                sql: 'UPDATE test SET name = ?',
                params: ['new'],
            });
        });
    });

    describe('exec', () => {
        it('should execute raw SQL', async () => {
            await dbOps.exec('CREATE TABLE test (id TEXT PRIMARY KEY)');

            expect(mockDb.calls[0]).toEqual({
                method: 'exec',
                sql: 'CREATE TABLE test (id TEXT PRIMARY KEY)',
            });
        });
    });

    // =========================================================================
    // TABLE-ORIENTED SELECT
    // =========================================================================

    describe('selectFrom', () => {
        it('should stream records from table', async () => {
            mockDb = createMockDb({
                '*': [[{ id: '1', name: 'Test' }]],
            });
            dbOps = new DatabaseOps(mockDb);

            const rows = await collect(dbOps.selectFrom('test_table'));

            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual({ id: '1', name: 'Test' });
        });

        it('should apply filter criteria', async () => {
            mockDb = createMockDb({ '*': [[]] });
            dbOps = new DatabaseOps(mockDb);

            await collect(
                dbOps.selectFrom('test_table', { where: { status: 'active' } })
            );

            const call = mockDb.calls[0];
            expect(call.sql).toContain('WHERE');
            expect(call.sql).toContain('status');
        });

        it('should apply limit', async () => {
            mockDb = createMockDb({ '*': [[]] });
            dbOps = new DatabaseOps(mockDb);

            await collect(dbOps.selectFrom('test_table', { limit: 10 }));

            expect(mockDb.calls[0].sql).toContain('LIMIT 10');
        });
    });

    describe('selectIds', () => {
        it('should stream records by IDs', async () => {
            mockDb = createMockDb({
                '*': [[{ id: 'a' }, { id: 'b' }]],
            });
            dbOps = new DatabaseOps(mockDb);

            const rows = await collect(dbOps.selectIds('test', ['a', 'b']));

            expect(rows).toHaveLength(2);
            const call = mockDb.calls[0];
            expect(call.sql).toContain('id');
            expect(call.sql).toContain('IN');
        });

        it('should return empty for empty ID list', async () => {
            const rows = await collect(dbOps.selectIds('test', []));

            expect(rows).toHaveLength(0);
            expect(mockDb.calls).toHaveLength(0); // No query executed
        });

        it('should accept async iterable of IDs', async () => {
            mockDb = createMockDb({ '*': [[{ id: 'x' }]] });
            dbOps = new DatabaseOps(mockDb);

            async function* idSource(): AsyncGenerator<string> {
                yield 'x';
                yield 'y';
            }

            const rows = await collect(dbOps.selectIds('test', idSource()));
            expect(rows).toHaveLength(1);
        });
    });

    // =========================================================================
    // TABLE-ORIENTED INSERT
    // =========================================================================

    describe('insertInto', () => {
        it('should insert records and stream them back', async () => {
            const records = [
                { id: '1', name: 'Alice' },
                { id: '2', name: 'Bob' },
            ];

            const inserted = await collect(dbOps.insertInto('users', records));

            expect(inserted).toHaveLength(2);
            expect(inserted[0]).toEqual({ id: '1', name: 'Alice' });
            expect(inserted[1]).toEqual({ id: '2', name: 'Bob' });
        });

        it('should execute INSERT for each record', async () => {
            const records = [{ id: '1', name: 'Test' }];

            await collect(dbOps.insertInto('users', records));

            expect(mockDb.calls).toHaveLength(1);
            const call = mockDb.calls[0];
            expect(call.method).toBe('execute');
            expect(call.sql).toContain('INSERT INTO users');
            expect(call.sql).toContain('id');
            expect(call.sql).toContain('name');
        });

        it('should handle null values', async () => {
            const records = [{ id: '1', description: null }];

            await collect(dbOps.insertInto('items', records));

            const call = mockDb.calls[0];
            expect(call.params).toContain(null);
        });

        it('should accept async iterable source', async () => {
            async function* source(): AsyncGenerator<DbRecord> {
                yield { id: 'a', val: 1 };
                yield { id: 'b', val: 2 };
            }

            const inserted = await collect(dbOps.insertInto('data', source()));
            expect(inserted).toHaveLength(2);
        });
    });

    // =========================================================================
    // TABLE-ORIENTED UPDATE
    // =========================================================================

    describe('updateIn', () => {
        it('should update records and stream updated rows', async () => {
            mockDb = createMockDb({
                '*': [[{ id: '1', name: 'Updated' }]],
            });
            dbOps = new DatabaseOps(mockDb);

            const updates = [{ id: '1', changes: { name: 'Updated' } }];
            const updated = await collect(dbOps.updateIn('users', updates));

            expect(updated).toHaveLength(1);
            // First call is UPDATE, second is SELECT to re-read
            const updateCall = mockDb.calls[0];
            expect(updateCall.method).toBe('execute');
            expect(updateCall.sql).toContain('UPDATE users');
            expect(updateCall.sql).toContain('SET');
            expect(updateCall.sql).toContain('name = ?');
        });

        it('should skip records with no changes', async () => {
            const updates = [{ id: '1', changes: {} }];
            const updated = await collect(dbOps.updateIn('users', updates));

            expect(updated).toHaveLength(0);
            expect(mockDb.calls).toHaveLength(0);
        });

        it('should use id in WHERE clause', async () => {
            mockDb = createMockDb({ '*': [[{ id: 'abc' }]] });
            dbOps = new DatabaseOps(mockDb);

            await collect(dbOps.updateIn('users', [{ id: 'abc', changes: { x: 1 } }]));

            const updateCall = mockDb.calls[0];
            expect(updateCall.sql).toContain('WHERE id = ?');
            // id should be last param
            const params = updateCall.params || [];
            expect(params[params.length - 1]).toBe('abc');
        });
    });

    // =========================================================================
    // TABLE-ORIENTED DELETE
    // =========================================================================

    describe('deleteFrom', () => {
        it('should delete records by IDs and stream deleted IDs', async () => {
            const deletedIds = await collect(dbOps.deleteFrom('users', ['1', '2']));

            expect(deletedIds).toEqual(['1', '2']);
            expect(mockDb.calls).toHaveLength(2);
        });

        it('should execute DELETE for each ID', async () => {
            await collect(dbOps.deleteFrom('users', ['abc']));

            const call = mockDb.calls[0];
            expect(call.method).toBe('execute');
            expect(call.sql).toBe('DELETE FROM users WHERE id = ?');
            expect(call.params).toEqual(['abc']);
        });

        it('should accept async iterable of IDs', async () => {
            async function* ids(): AsyncGenerator<string> {
                yield 'x';
                yield 'y';
            }

            const deleted = await collect(dbOps.deleteFrom('items', ids()));
            expect(deleted).toEqual(['x', 'y']);
        });
    });

    // =========================================================================
    // STREAMING COMPOSITION
    // =========================================================================

    describe('streaming composition', () => {
        it('should allow piping query results to insert', async () => {
            // Simulate: SELECT from source, INSERT into target
            mockDb = createMockDb({
                '*': [[{ id: '1', name: 'Copy' }]],
            });
            dbOps = new DatabaseOps(mockDb);

            // Read from source
            const source = dbOps.query<DbRecord>('SELECT * FROM source');

            // Insert into target (wrapping generator)
            async function* transform(src: AsyncIterable<DbRecord>): AsyncGenerator<DbRecord> {
                for await (const row of src) {
                    yield { ...row, copied: true };
                }
            }

            const inserted = await collect(dbOps.insertInto('target', transform(source)));

            expect(inserted).toHaveLength(1);
            expect(inserted[0]).toEqual({ id: '1', name: 'Copy', copied: true });
        });
    });
});
