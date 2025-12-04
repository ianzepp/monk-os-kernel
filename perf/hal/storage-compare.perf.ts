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

describe('Storage Compare: Concurrent Operations', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.concurrent');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_concurrent`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_concurrent`);
        await postgres.init();
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_concurrent CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.concurrent');
            await unlink(SQLITE_PATH + '.concurrent-wal');
            await unlink(SQLITE_PATH + '.concurrent-shm');
        } catch {
            // Ignore
        }
    });

    it('Concurrent PUT: 10 parallel batches of 100 ops', async () => {
        const batches = 10;
        const opsPerBatch = 100;
        const value = generateValue(500);

        const sqliteStart = performance.now();
        await Promise.all(
            Array.from({ length: batches }, (_, b) =>
                (async () => {
                    for (let i = 0; i < opsPerBatch; i++) {
                        await sqlite.put(generateKey(`sqlite-concurrent-${b}`, i), value);
                    }
                })()
            )
        );
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        await Promise.all(
            Array.from({ length: batches }, (_, b) =>
                (async () => {
                    for (let i = 0; i < opsPerBatch; i++) {
                        await postgres.put(generateKey(`pg-concurrent-${b}`, i), value);
                    }
                })()
            )
        );
        const pgMs = performance.now() - pgStart;

        const totalOps = batches * opsPerBatch;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nConcurrent PUT (10 batches x 100 ops):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });

    it('Concurrent GET: 10 parallel readers', async () => {
        const readers = 10;
        const readsPerReader = 100;

        const sqliteStart = performance.now();
        await Promise.all(
            Array.from({ length: readers }, (_, r) =>
                (async () => {
                    for (let i = 0; i < readsPerReader; i++) {
                        await sqlite.get(generateKey(`sqlite-concurrent-${r % 10}`, i));
                    }
                })()
            )
        );
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        await Promise.all(
            Array.from({ length: readers }, (_, r) =>
                (async () => {
                    for (let i = 0; i < readsPerReader; i++) {
                        await postgres.get(generateKey(`pg-concurrent-${r % 10}`, i));
                    }
                })()
            )
        );
        const pgMs = performance.now() - pgStart;

        const totalOps = readers * readsPerReader;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nConcurrent GET (10 readers x 100 ops):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });

    it('Concurrent mixed: 5 writers + 5 readers', async () => {
        const workers = 5;
        const opsPerWorker = 100;
        const value = generateValue(500);

        const sqliteStart = performance.now();
        await Promise.all([
            // Writers
            ...Array.from({ length: workers }, (_, w) =>
                (async () => {
                    for (let i = 0; i < opsPerWorker; i++) {
                        await sqlite.put(generateKey(`sqlite-mixed-writer-${w}`, i), value);
                    }
                })()
            ),
            // Readers
            ...Array.from({ length: workers }, (_, r) =>
                (async () => {
                    for (let i = 0; i < opsPerWorker; i++) {
                        await sqlite.get(generateKey(`sqlite-concurrent-${r}`, i % 100));
                    }
                })()
            ),
        ]);
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        await Promise.all([
            // Writers
            ...Array.from({ length: workers }, (_, w) =>
                (async () => {
                    for (let i = 0; i < opsPerWorker; i++) {
                        await postgres.put(generateKey(`pg-mixed-writer-${w}`, i), value);
                    }
                })()
            ),
            // Readers
            ...Array.from({ length: workers }, (_, r) =>
                (async () => {
                    for (let i = 0; i < opsPerWorker; i++) {
                        await postgres.get(generateKey(`pg-concurrent-${r}`, i % 100));
                    }
                })()
            ),
        ]);
        const pgMs = performance.now() - pgStart;

        const totalOps = workers * 2 * opsPerWorker;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nConcurrent mixed (5 writers + 5 readers x 100 ops):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });
});

describe('Storage Compare: Access Patterns', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.patterns');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_patterns`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_patterns`);
        await postgres.init();

        // Pre-populate with 5000 sequential keys
        const value = generateValue(200);
        for (let i = 0; i < 5000; i++) {
            await sqlite.put(generateKey('seq', i), value);
            await postgres.put(generateKey('seq', i), value);
        }
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_patterns CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.patterns');
            await unlink(SQLITE_PATH + '.patterns-wal');
            await unlink(SQLITE_PATH + '.patterns-shm');
        } catch {
            // Ignore
        }
    });

    it('Sequential read: 1000 consecutive keys', async () => {
        const count = 1000;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.get(generateKey('seq', i));
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.get(generateKey('seq', i));
        });

        console.log('\nSequential read (1000 consecutive keys):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Random read: 1000 random keys from 5000', async () => {
        const count = 1000;
        const randomIndices = Array.from({ length: count }, () => Math.floor(Math.random() * 5000));

        let idx = 0;
        const sqliteResult = await runBench('SQLite', sqlite, count, async (s) => {
            await s.get(generateKey('seq', randomIndices[idx++]!));
        });

        idx = 0;
        const pgResult = await runBench('PostgreSQL', postgres, count, async (s) => {
            await s.get(generateKey('seq', randomIndices[idx++]!));
        });

        console.log('\nRandom read (1000 random keys from 5000):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Hot key access: 1000 reads of 10 hot keys', async () => {
        const count = 1000;
        const hotKeys = Array.from({ length: 10 }, (_, i) => generateKey('seq', i * 100));

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.get(hotKeys[i % 10]!);
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.get(hotKeys[i % 10]!);
        });

        console.log('\nHot key access (1000 reads of 10 hot keys):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Zipfian distribution: 80% reads to 20% of keys', async () => {
        const count = 1000;
        // Simulate Zipfian-like access: 80% of reads go to first 20% of keys
        const zipfIndices = Array.from({ length: count }, () => {
            if (Math.random() < 0.8) {
                return Math.floor(Math.random() * 1000); // First 1000 keys (20%)
            } else {
                return 1000 + Math.floor(Math.random() * 4000); // Remaining 4000 keys
            }
        });

        let idx = 0;
        const sqliteResult = await runBench('SQLite', sqlite, count, async (s) => {
            await s.get(generateKey('seq', zipfIndices[idx++]!));
        });

        idx = 0;
        const pgResult = await runBench('PostgreSQL', postgres, count, async (s) => {
            await s.get(generateKey('seq', zipfIndices[idx++]!));
        });

        console.log('\nZipfian distribution (80/20 access pattern):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('Storage Compare: Key Characteristics', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.keys');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_keys`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_keys`);
        await postgres.init();
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_keys CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.keys');
            await unlink(SQLITE_PATH + '.keys-wal');
            await unlink(SQLITE_PATH + '.keys-shm');
        } catch {
            // Ignore
        }
    });

    it('Short keys: 500 x 10-char keys', async () => {
        const count = 500;
        const value = generateValue(100);
        const shortKey = (prefix: string, i: number) => `${prefix}${i.toString().padStart(4, '0')}`;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.put(shortKey('s', i), value);
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.put(shortKey('p', i), value);
        });

        console.log('\nShort keys (500 x 10-char keys):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Long keys: 500 x 200-char keys', async () => {
        const count = 500;
        const value = generateValue(100);
        const longKeyPrefix = 'a'.repeat(180);
        const longKey = (prefix: string, i: number) => `${prefix}/${longKeyPrefix}/${i.toString().padStart(8, '0')}`;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.put(longKey('sqlite', i), value);
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.put(longKey('pg', i), value);
        });

        console.log('\nLong keys (500 x 200-char keys):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Hierarchical keys: 500 x path-like keys', async () => {
        const count = 500;
        const value = generateValue(100);
        const hierKey = (prefix: string, i: number) => {
            const a = Math.floor(i / 100);
            const b = Math.floor((i % 100) / 10);
            const c = i % 10;
            return `${prefix}/level1-${a}/level2-${b}/level3-${c}/item`;
        };

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.put(hierKey('sqlite', i), value);
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.put(hierKey('pg', i), value);
        });

        console.log('\nHierarchical keys (500 x path-like keys):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('UUID keys: 500 x random UUIDs', async () => {
        const count = 500;
        const value = generateValue(100);
        const uuids = Array.from({ length: count }, () => crypto.randomUUID());

        let idx = 0;
        const sqliteResult = await runBench('SQLite', sqlite, count, async (s) => {
            await s.put(`sqlite:${uuids[idx++]}`, value);
        });

        idx = 0;
        const pgResult = await runBench('PostgreSQL', postgres, count, async (s) => {
            await s.put(`pg:${uuids[idx++]}`, value);
        });

        console.log('\nUUID keys (500 x random UUIDs):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('Storage Compare: Update Patterns', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.updates');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_updates`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_updates`);
        await postgres.init();

        // Pre-populate
        const value = generateValue(500);
        for (let i = 0; i < 1000; i++) {
            await sqlite.put(generateKey('upd', i), value);
            await postgres.put(generateKey('upd', i), value);
        }
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_updates CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.updates');
            await unlink(SQLITE_PATH + '.updates-wal');
            await unlink(SQLITE_PATH + '.updates-shm');
        } catch {
            // Ignore
        }
    });

    it('Overwrite same size: 1000 updates', async () => {
        const count = 1000;
        const value = generateValue(500);

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.put(generateKey('upd', i), value);
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.put(generateKey('upd', i), value);
        });

        console.log('\nOverwrite same size (1000 updates):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Overwrite growing: 500 updates 100B -> 1KB', async () => {
        const count = 500;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            const size = 100 + (i * 2); // 100B to ~1KB
            await s.put(generateKey('upd', i), generateValue(size));
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            const size = 100 + (i * 2);
            await s.put(generateKey('upd', i), generateValue(size));
        });

        console.log('\nOverwrite growing (500 updates 100B -> 1KB):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Read-modify-write: 500 cycles', async () => {
        const count = 500;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            const existing = await s.get(generateKey('upd', i));
            if (existing) {
                const modified = new Uint8Array(existing.length + 10);
                modified.set(existing);
                await s.put(generateKey('upd', i), modified);
            }
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            const existing = await s.get(generateKey('upd', i));
            if (existing) {
                const modified = new Uint8Array(existing.length + 10);
                modified.set(existing);
                await s.put(generateKey('upd', i), modified);
            }
        });

        console.log('\nRead-modify-write (500 cycles):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Single key hot update: 1000 writes to same key', async () => {
        const count = 1000;
        const key = 'hot-key';

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.put(key, generateValue(100 + (i % 100)));
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.put(key, generateValue(100 + (i % 100)));
        });

        console.log('\nSingle key hot update (1000 writes to same key):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('Storage Compare: Read/Write Ratios', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.ratios');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_ratios`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_ratios`);
        await postgres.init();

        // Pre-populate
        const value = generateValue(200);
        for (let i = 0; i < 1000; i++) {
            await sqlite.put(generateKey('ratio', i), value);
            await postgres.put(generateKey('ratio', i), value);
        }
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_ratios CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.ratios');
            await unlink(SQLITE_PATH + '.ratios-wal');
            await unlink(SQLITE_PATH + '.ratios-shm');
        } catch {
            // Ignore
        }
    });

    it('Read-heavy: 95% reads, 5% writes', async () => {
        const totalOps = 1000;
        const value = generateValue(200);

        const sqliteStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.95) {
                await sqlite.get(generateKey('ratio', i % 1000));
            } else {
                await sqlite.put(generateKey('ratio', i % 1000), value);
            }
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.95) {
                await postgres.get(generateKey('ratio', i % 1000));
            } else {
                await postgres.put(generateKey('ratio', i % 1000), value);
            }
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nRead-heavy (95% reads, 5% writes):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Balanced: 50% reads, 50% writes', async () => {
        const totalOps = 1000;
        const value = generateValue(200);

        const sqliteStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (i % 2 === 0) {
                await sqlite.get(generateKey('ratio', i % 1000));
            } else {
                await sqlite.put(generateKey('ratio', i % 1000), value);
            }
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (i % 2 === 0) {
                await postgres.get(generateKey('ratio', i % 1000));
            } else {
                await postgres.put(generateKey('ratio', i % 1000), value);
            }
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nBalanced (50% reads, 50% writes):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Write-heavy: 5% reads, 95% writes', async () => {
        const totalOps = 1000;
        const value = generateValue(200);

        const sqliteStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.05) {
                await sqlite.get(generateKey('ratio', i % 1000));
            } else {
                await sqlite.put(generateKey('ratio', i % 1000), value);
            }
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.05) {
                await postgres.get(generateKey('ratio', i % 1000));
            } else {
                await postgres.put(generateKey('ratio', i % 1000), value);
            }
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nWrite-heavy (5% reads, 95% writes):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Append-only: 1000 inserts (no updates)', async () => {
        const count = 1000;
        const value = generateValue(200);

        const sqliteResult = await runBench('SQLite', sqlite, count, async (s, i) => {
            await s.put(generateKey('append-sqlite', i), value);
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (s, i) => {
            await s.put(generateKey('append-pg', i), value);
        });

        console.log('\nAppend-only (1000 new inserts):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('Storage Compare: Transaction Patterns', () => {
    let sqlite: BunStorageEngine;
    let postgres: PostgresStorageEngine;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        sqlite = new BunStorageEngine(SQLITE_PATH + '.txpatterns');
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_txpatterns`);
        postgres = new PostgresStorageEngine(`${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_txpatterns`);
        await postgres.init();

        // Pre-populate
        const value = generateValue(100);
        for (let i = 0; i < 500; i++) {
            await sqlite.put(generateKey('txp', i), value);
            await postgres.put(generateKey('txp', i), value);
        }
    });

    afterAll(async () => {
        await sqlite.close();
        await postgres.close();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_txpatterns CASCADE`);
        adminSql.close();

        try {
            await unlink(SQLITE_PATH + '.txpatterns');
            await unlink(SQLITE_PATH + '.txpatterns-wal');
            await unlink(SQLITE_PATH + '.txpatterns-shm');
        } catch {
            // Ignore
        }
    });

    it('Rollback performance: 50 transactions with rollback', async () => {
        const txCount = 50;
        const opsPerTx = 20;
        const value = generateValue(100);

        const sqliteStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await sqlite.begin();
            for (let i = 0; i < opsPerTx; i++) {
                await tx.put(generateKey(`sqlite-rollback-${t}`, i), value);
            }
            await tx.rollback();
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await postgres.begin();
            for (let i = 0; i < opsPerTx; i++) {
                await tx.put(generateKey(`pg-rollback-${t}`, i), value);
            }
            await tx.rollback();
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = txCount * opsPerTx;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / txCount, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / txCount, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nRollback performance (50 tx x 20 ops each):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Read-only transaction: 50 tx with only reads', async () => {
        const txCount = 50;
        const readsPerTx = 20;

        const sqliteStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await sqlite.begin();
            for (let i = 0; i < readsPerTx; i++) {
                await tx.get(generateKey('txp', (t * readsPerTx + i) % 500));
            }
            await tx.commit();
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await postgres.begin();
            for (let i = 0; i < readsPerTx; i++) {
                await tx.get(generateKey('txp', (t * readsPerTx + i) % 500));
            }
            await tx.commit();
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = txCount * readsPerTx;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / txCount, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / txCount, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nRead-only transactions (50 tx x 20 reads):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Mini transactions: 200 tx with 2 ops each', async () => {
        const txCount = 200;
        const value = generateValue(100);

        const sqliteStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await sqlite.begin();
            await tx.get(generateKey('txp', t % 500));
            await tx.put(generateKey(`sqlite-mini-${t}`, 0), value);
            await tx.commit();
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await postgres.begin();
            await tx.get(generateKey('txp', t % 500));
            await tx.put(generateKey(`pg-mini-${t}`, 0), value);
            await tx.commit();
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = txCount * 2;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / txCount, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / txCount, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nMini transactions (200 tx x 2 ops each):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });

    it('Batch delete in transaction: 10 tx deleting 100 keys each', async () => {
        // First, insert keys to delete
        const value = generateValue(100);
        for (let t = 0; t < 10; t++) {
            for (let i = 0; i < 100; i++) {
                await sqlite.put(generateKey(`sqlite-del-${t}`, i), value);
                await postgres.put(generateKey(`pg-del-${t}`, i), value);
            }
        }

        const txCount = 10;
        const deletesPerTx = 100;

        const sqliteStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await sqlite.begin();
            for (let i = 0; i < deletesPerTx; i++) {
                await tx.delete(generateKey(`sqlite-del-${t}`, i));
            }
            await tx.commit();
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let t = 0; t < txCount; t++) {
            const tx = await postgres.begin();
            for (let i = 0; i < deletesPerTx; i++) {
                await tx.delete(generateKey(`pg-del-${t}`, i));
            }
            await tx.commit();
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = txCount * deletesPerTx;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / txCount, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / txCount, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nBatch delete (10 tx x 100 deletes each):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });
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
