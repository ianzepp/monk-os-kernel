/**
 * Storage Engine Performance Comparison: SQLite vs PostgreSQL
 *
 * Compares entity lifecycle performance between storage backends:
 * - Single entity operations (put, get, delete)
 * - Bulk operations (batch put, list)
 * - Transactions (commit, rollback)
 * - Mixed workloads
 *
 * Run with: bun run perf -- --grep "Storage Compare"
 * Or: POSTGRES_URL=postgresql://localhost/monk_os bun test perf/hal/storage-compare.perf.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { BunStorageEngine, PostgresStorageEngine } from '@src/hal/index.js';
import type { StorageEngine } from '@src/hal/storage.js';
import { unlink } from 'node:fs/promises';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TIMEOUT_MEDIUM = 60_000;
const TIMEOUT_LONG = 120_000;

// PostgreSQL connection
const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgresql://localhost/monk_os';

// SQLite temp file
const SQLITE_PATH = `/tmp/perf-storage-${Date.now()}.db`;

// Test schema for PostgreSQL isolation
const PG_SCHEMA = `perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// =============================================================================
// HELPERS
// =============================================================================

function formatRate(count: number, ms: number): string {
    const perSec = (count / ms) * 1000;
    return `${perSec.toFixed(0)} ops/sec`;
}

function formatTime(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function generateKey(prefix: string, i: number): string {
    return `${prefix}:${i.toString().padStart(8, '0')}`;
}

function generateValue(size: number): Uint8Array {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 256;
    }
    return data;
}

interface BenchResult {
    name: string;
    ops: number;
    totalMs: number;
    avgMs: number;
    opsPerSec: number;
}

function printResults(results: BenchResult[]): void {
    console.log('\n┌─────────────────────┬──────────┬────────────┬──────────┬────────────┐');
    console.log('│ Backend             │ Ops      │ Total      │ Avg/Op   │ Throughput │');
    console.log('├─────────────────────┼──────────┼────────────┼──────────┼────────────┤');
    for (const r of results) {
        const name = r.name.padEnd(19);
        const ops = r.ops.toString().padStart(8);
        const total = formatTime(r.totalMs).padStart(10);
        const avg = formatTime(r.avgMs).padStart(8);
        const throughput = formatRate(r.ops, r.totalMs).padStart(10);
        console.log(`│ ${name} │ ${ops} │ ${total} │ ${avg} │ ${throughput} │`);
    }
    console.log('└─────────────────────┴──────────┴────────────┴──────────┴────────────┘\n');
}

async function runBench(
    name: string,
    storage: StorageEngine,
    ops: number,
    fn: (storage: StorageEngine, i: number) => Promise<void>
): Promise<BenchResult> {
    const start = performance.now();
    for (let i = 0; i < ops; i++) {
        await fn(storage, i);
    }
    const totalMs = performance.now() - start;
    return {
        name,
        ops,
        totalMs,
        avgMs: totalMs / ops,
        opsPerSec: (ops / totalMs) * 1000,
    };
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Storage Compare: Single Operations', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        // Setup SQLite
        sqlite = new BunStorageEngine(SQLITE_PATH);

        // Setup PostgreSQL with isolated schema
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}`);
        await postgres.init();
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH);
            await unlink(SQLITE_PATH + '-wal');
            await unlink(SQLITE_PATH + '-shm');
        } catch {
            // Ignore cleanup errors
        }
    });

    it('PUT: 1000 x 1KB values', async () => {
        const count = 1000;
        const value = generateValue(1024);

        const results = await Promise.all([
            runBench('SQLite', sqlite, count, async (s, i) => {
                await s.put(generateKey('sqlite-put', i), value);
            }),
            runBench('PostgreSQL', postgres, count, async (s, i) => {
                await s.put(generateKey('pg-put', i), value);
            }),
        ]);

        printResults(results);
        expect(results[0]!.totalMs).toBeLessThan(10000);
        expect(results[1]!.totalMs).toBeLessThan(30000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('GET: 1000 x 1KB values (after PUT)', async () => {
        const count = 1000;

        const results = await Promise.all([
            runBench('SQLite', sqlite, count, async (s, i) => {
                await s.get(generateKey('sqlite-put', i));
            }),
            runBench('PostgreSQL', postgres, count, async (s, i) => {
                await s.get(generateKey('pg-put', i));
            }),
        ]);

        printResults(results);
        expect(results[0]!.totalMs).toBeLessThan(5000);
        expect(results[1]!.totalMs).toBeLessThan(10000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('EXISTS: 1000 checks', async () => {
        const count = 1000;

        const results = await Promise.all([
            runBench('SQLite', sqlite, count, async (s, i) => {
                await s.exists(generateKey('sqlite-put', i));
            }),
            runBench('PostgreSQL', postgres, count, async (s, i) => {
                await s.exists(generateKey('pg-put', i));
            }),
        ]);

        printResults(results);
        expect(results[0]!.totalMs).toBeLessThan(5000);
        expect(results[1]!.totalMs).toBeLessThan(10000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('STAT: 1000 metadata lookups', async () => {
        const count = 1000;

        const results = await Promise.all([
            runBench('SQLite', sqlite, count, async (s, i) => {
                await s.stat(generateKey('sqlite-put', i));
            }),
            runBench('PostgreSQL', postgres, count, async (s, i) => {
                await s.stat(generateKey('pg-put', i));
            }),
        ]);

        printResults(results);
        expect(results[0]!.totalMs).toBeLessThan(5000);
        expect(results[1]!.totalMs).toBeLessThan(10000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('DELETE: 1000 keys', async () => {
        const count = 1000;

        const results = await Promise.all([
            runBench('SQLite', sqlite, count, async (s, i) => {
                await s.delete(generateKey('sqlite-put', i));
            }),
            runBench('PostgreSQL', postgres, count, async (s, i) => {
                await s.delete(generateKey('pg-put', i));
            }),
        ]);

        printResults(results);
        expect(results[0]!.totalMs).toBeLessThan(10000);
        expect(results[1]!.totalMs).toBeLessThan(30000);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('Storage Compare: Bulk Operations', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.bulk');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_bulk`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_bulk`);
        await postgres.init();
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_bulk CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.bulk');
            await unlink(SQLITE_PATH + '.bulk-wal');
            await unlink(SQLITE_PATH + '.bulk-shm');
        } catch {
            // Ignore
        }
    });

    it('PUT: 10000 x 100B values', async () => {
        const count = 10000;
        const value = generateValue(100);

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.put(generateKey('bulk', i), value);
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.put(generateKey('bulk', i), value);
        });

        printResults([sqliteResult, pgResult]);
        expect(sqliteResult.totalMs).toBeLessThan(60000);
        expect(pgResult.totalMs).toBeLessThan(120000);
    }, { timeout: TIMEOUT_LONG });

    it('LIST: prefix scan over 10000 keys', async () => {
        async function countKeys(storage: StorageEngine, prefix: string): Promise<number> {
            let count = 0;
            for await (const _key of storage.list(prefix)) {
                count++;
            }
            return count;
        }

        const iterations = 10;

        const sqliteStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const count = await countKeys(sqlite, 'bulk:');
            expect(count).toBe(10000);
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const count = await countKeys(postgres, 'bulk:');
            expect(count).toBe(10000);
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: iterations, totalMs: sqliteMs, avgMs: sqliteMs / iterations, opsPerSec: (iterations / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: iterations, totalMs: pgMs, avgMs: pgMs / iterations, opsPerSec: (iterations / pgMs) * 1000 },
        ];

        console.log('\nLIST 10000 keys x 10 iterations:');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });
});

describe('Storage Compare: Transactions', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.tx');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_tx`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_tx`);
        await postgres.init();
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_tx CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.tx');
            await unlink(SQLITE_PATH + '.tx-wal');
            await unlink(SQLITE_PATH + '.tx-shm');
        } catch {
            // Ignore
        }
    });

    it('Transaction: 100 commits with 10 ops each', async () => {
        const txCount = 100;
        const opsPerTx = 10;
        const value = generateValue(100);

        const sqliteStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await sqlite.begin();
            for (let i = 0; i < opsPerTx; i++) {
                await tx.put(generateKey(`sqlite-tx-${t}`, i), value);
            }
            await tx.commit();
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await postgres.begin();
            for (let i = 0; i < opsPerTx; i++) {
                await tx.put(generateKey(`pg-tx-${t}`, i), value);
            }
            await tx.commit();
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = txCount * opsPerTx;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / txCount, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / txCount, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log(`\n${txCount} transactions x ${opsPerTx} ops each:`);
        printResults(results);
        expect(sqliteMs).toBeLessThan(30000);
        expect(pgMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });

    it('Transaction: 10 large commits with 1000 ops each', async () => {
        const txCount = 10;
        const opsPerTx = 1000;
        const value = generateValue(100);

        const sqliteStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await sqlite.begin();
            for (let i = 0; i < opsPerTx; i++) {
                await tx.put(generateKey(`sqlite-bigtx-${t}`, i), value);
            }
            await tx.commit();
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await postgres.begin();
            for (let i = 0; i < opsPerTx; i++) {
                await tx.put(generateKey(`pg-bigtx-${t}`, i), value);
            }
            await tx.commit();
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = txCount * opsPerTx;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / txCount, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / txCount, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log(`\n${txCount} transactions x ${opsPerTx} ops each:`);
        printResults(results);
        expect(sqliteMs).toBeLessThan(60000);
        expect(pgMs).toBeLessThan(120000);
    }, { timeout: TIMEOUT_LONG });
});

describe('Storage Compare: Mixed Workload', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.mixed');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_mixed`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_mixed`);
        await postgres.init();

        // Pre-populate with data
        const value = generateValue(500);
        for (let i = 0; i < 1000; i++) {
            await sqlite.put(generateKey('mixed', i), value);
            await postgres.put(generateKey('mixed', i), value);
        }
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_mixed CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.mixed');
            await unlink(SQLITE_PATH + '.mixed-wal');
            await unlink(SQLITE_PATH + '.mixed-shm');
        } catch {
            // Ignore
        }
    });

    it('Mixed: 1000 cycles of read-write-delete', async () => {
        const cycles = 1000;
        const value = generateValue(500);

        const sqliteStart = performance.now();
        for (let i = 0; i < cycles; i++) {
            // Read existing
            await sqlite.get(generateKey('mixed', i % 1000));
            // Write new
            await sqlite.put(generateKey('sqlite-new', i), value);
            // Delete new
            await sqlite.delete(generateKey('sqlite-new', i));
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < cycles; i++) {
            // Read existing
            await postgres.get(generateKey('mixed', i % 1000));
            // Write new
            await postgres.put(generateKey('pg-new', i), value);
            // Delete new
            await postgres.delete(generateKey('pg-new', i));
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = cycles * 3; // 3 ops per cycle
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / cycles, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / cycles, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nMixed workload (read-write-delete x 1000):');
        printResults(results);
        expect(sqliteMs).toBeLessThan(60000);
        expect(pgMs).toBeLessThan(120000);
    }, { timeout: TIMEOUT_LONG });

    it('Mixed: Transaction with mixed ops', async () => {
        const txCount = 50;
        const value = generateValue(500);

        const sqliteStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await sqlite.begin();
            for (let i = 0; i < 10; i++) {
                await tx.get(generateKey('mixed', (t * 10 + i) % 1000));
                await tx.put(generateKey(`sqlite-mixed-tx-${t}`, i), value);
            }
            await tx.commit();
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await postgres.begin();
            for (let i = 0; i < 10; i++) {
                await tx.get(generateKey('mixed', (t * 10 + i) % 1000));
                await tx.put(generateKey(`pg-mixed-tx-${t}`, i), value);
            }
            await tx.commit();
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = txCount * 20; // 20 ops per tx (10 get + 10 put)
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / txCount, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / txCount, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nTransactional mixed workload (50 tx x 20 ops):');
        printResults(results);
        expect(sqliteMs).toBeLessThan(30000);
        expect(pgMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });
});

describe('Storage Compare: Value Sizes', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.sizes');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_sizes`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_sizes`);
        await postgres.init();
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_sizes CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.sizes');
            await unlink(SQLITE_PATH + '.sizes-wal');
            await unlink(SQLITE_PATH + '.sizes-shm');
        } catch {
            // Ignore
        }
    });

    const sizes = [
        { name: '100B', size: 100, count: 1000 },
        { name: '1KB', size: 1024, count: 500 },
        { name: '10KB', size: 10 * 1024, count: 100 },
        { name: '100KB', size: 100 * 1024, count: 50 },
        { name: '1MB', size: 1024 * 1024, count: 10 },
    ];

    for (const { name, size, count } of sizes) {
        it(`PUT ${count} x ${name} values`, async () => {
            const value = generateValue(size);

            const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
                await s.put(generateKey(`size-${name}`, i), value);
            });

            const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
                await s.put(generateKey(`size-${name}`, i), value);
            });

            console.log(`\nPUT ${count} x ${name}:`);
            printResults([sqliteResult, pgResult]);
        }, { timeout: TIMEOUT_LONG });
    }
});
