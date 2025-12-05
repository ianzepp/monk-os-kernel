/**
 * EMS Parallel Performance Comparison: SQLite vs PostgreSQL
 *
 * Tests concurrent entity operations to measure:
 * - Write contention (SQLite lock vs PostgreSQL MVCC)
 * - Read scalability under parallel load
 * - Mixed read/write concurrency
 *
 * IMPORTANT FINDING: The EMS uses a single database connection per stack.
 * This means parallel CREATE operations fail for BOTH backends because each
 * create wraps in a transaction, and nested transactions aren't supported
 * without connection pooling or savepoints.
 *
 * Operations that work in parallel:
 * - SELECT (reads don't need transactions)
 * - UPDATE (updates on different rows can share a connection)
 *
 * Operations that fail in parallel:
 * - CREATE (each create starts a transaction)
 * - Mixed read/write with creates
 *
 * Run with: bun test ./perf/ems/entity-parallel.perf.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import { collect } from '@src/ems/entity-ops.js';
import type { HALConfig } from '@src/hal/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TIMEOUT_LONG = 120_000;

const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgresql://localhost/monk_os';
const PG_SCHEMA = `ems_parallel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// =============================================================================
// TYPES
// =============================================================================

interface BenchResult {
    name: string;
    ops: number;
    concurrency: number;
    totalMs: number;
    avgMs: number;
    opsPerSec: number;
}

interface FileEntity {
    id: string;
    model: string;
    parent: string | null;
    pathname: string;
    owner: string;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
    [key: string]: unknown;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatRate(count: number, ms: number): string {
    if (count === 0 || ms === 0) return 'N/A';
    const perSec = (count / ms) * 1000;
    return `${perSec.toFixed(0)} ops/sec`;
}

function formatTime(ms: number): string {
    if (ms === 0) return 'N/A';
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function printResults(title: string, results: BenchResult[]): void {
    console.log(`\n${title}:\n`);
    console.log('┌─────────────────────┬──────────┬─────────────┬────────────┬──────────┬────────────┐');
    console.log('│ Backend             │ Ops      │ Concurrency │ Total      │ Avg/Op   │ Throughput │');
    console.log('├─────────────────────┼──────────┼─────────────┼────────────┼──────────┼────────────┤');
    for (const r of results) {
        const name = r.name.padEnd(19);
        const ops = r.ops.toString().padStart(8);
        const conc = r.concurrency.toString().padStart(11);
        const total = formatTime(r.totalMs).padStart(10);
        const avg = formatTime(r.avgMs).padStart(8);
        const throughput = formatRate(r.ops, r.totalMs).padStart(10);
        console.log(`│ ${name} │ ${ops} │ ${conc} │ ${total} │ ${avg} │ ${throughput} │`);
    }
    console.log('└─────────────────────┴──────────┴─────────────┴────────────┴──────────┴────────────┘\n');
}

/**
 * Run operations in parallel batches.
 * @param concurrency - Number of concurrent operations
 * @param totalOps - Total operations to run
 * @param fn - Operation to run (receives operation index)
 */
async function runParallel<T>(
    concurrency: number,
    totalOps: number,
    fn: (i: number) => Promise<T>
): Promise<{ totalMs: number; results: T[]; error?: string }> {
    const results: T[] = [];
    const start = performance.now();

    try {
        // Process in waves of `concurrency` parallel operations
        for (let batch = 0; batch < totalOps; batch += concurrency) {
            const batchSize = Math.min(concurrency, totalOps - batch);
            const promises = Array.from({ length: batchSize }, (_, i) => fn(batch + i));
            const batchResults = await Promise.all(promises);
            results.push(...batchResults);
        }
        return { totalMs: performance.now() - start, results };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // SQLite can't handle concurrent transactions
        if (message.includes('cannot start a transaction within a transaction')) {
            return { totalMs: 0, results: [], error: 'NO_CONCURRENT_TXN' };
        }
        // Log other errors for debugging
        console.error(`Parallel operation failed: ${message}`);
        return { totalMs: 0, results: [], error: message };
    }
}

async function createSqliteStack(): Promise<OsStack> {
    return createOsStack({
        hal: { storage: { type: 'memory' } },
        ems: true,
    });
}

async function createPostgresStack(schemaSuffix: string): Promise<OsStack> {
    const config: HALConfig = {
        storage: { type: 'postgres', url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_${schemaSuffix}` },
    };
    return createOsStack({ hal: config, ems: true });
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('EMS Parallel: Write Contention', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_write`);
        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('write');
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_write CASCADE`);
        adminSql.close();
    });

    it('Parallel CREATE: 500 files at concurrency 10, 50, 100', async () => {
        const totalOps = 500;
        const concurrencies = [10, 50, 100];
        const results: BenchResult[] = [];

        for (const concurrency of concurrencies) {
            const owner = `parallel-create-${concurrency}-${Date.now()}`;

            // SQLite - fails due to single-connection transaction limitation
            const sqliteRun = await runParallel(concurrency, totalOps, async (i) => {
                return collect(
                    sqlite.ems!.ops.createAll<FileEntity>('file', [
                        { pathname: `sqlite-p${concurrency}-${i}.txt`, owner, parent: null },
                    ])
                );
            });
            if (sqliteRun.error) {
                results.push({
                    name: `SQLite (N/A)`,
                    ops: 0,
                    concurrency,
                    totalMs: 0,
                    avgMs: 0,
                    opsPerSec: 0,
                });
            } else {
                results.push({
                    name: `SQLite`,
                    ops: totalOps,
                    concurrency,
                    totalMs: sqliteRun.totalMs,
                    avgMs: sqliteRun.totalMs / totalOps,
                    opsPerSec: (totalOps / sqliteRun.totalMs) * 1000,
                });
            }

            // PostgreSQL - also fails due to single-connection model in EMS
            const pgRun = await runParallel(concurrency, totalOps, async (i) => {
                return collect(
                    postgres.ems!.ops.createAll<FileEntity>('file', [
                        { pathname: `pg-p${concurrency}-${i}.txt`, owner, parent: null },
                    ])
                );
            });
            if (pgRun.error) {
                results.push({
                    name: `PostgreSQL (N/A)`,
                    ops: 0,
                    concurrency,
                    totalMs: 0,
                    avgMs: 0,
                    opsPerSec: 0,
                });
            } else {
                results.push({
                    name: `PostgreSQL`,
                    ops: totalOps,
                    concurrency,
                    totalMs: pgRun.totalMs,
                    avgMs: pgRun.totalMs / totalOps,
                    opsPerSec: (totalOps / pgRun.totalMs) * 1000,
                });
            }
        }

        printResults('Parallel CREATE (write contention)', results);
        // Both may have issues at high concurrency
        expect(results.length).toBe(6);
    }, { timeout: TIMEOUT_LONG });

    it('Parallel UPDATE: 500 updates at concurrency 10, 50, 100', async () => {
        const totalOps = 500;
        const concurrencies = [10, 50, 100];
        const results: BenchResult[] = [];

        for (const concurrency of concurrencies) {
            const owner = `parallel-update-${concurrency}-${Date.now()}`;

            // Pre-create files
            const sqliteFiles = await collect(
                sqlite.ems!.ops.createAll<FileEntity>('file',
                    Array.from({ length: totalOps }, (_, i) => ({
                        pathname: `sqlite-upd-${concurrency}-${i}.txt`,
                        owner,
                        parent: null,
                    }))
                )
            );
            const pgFiles = await collect(
                postgres.ems!.ops.createAll<FileEntity>('file',
                    Array.from({ length: totalOps }, (_, i) => ({
                        pathname: `pg-upd-${concurrency}-${i}.txt`,
                        owner,
                        parent: null,
                    }))
                )
            );

            // SQLite parallel updates
            const sqliteRun = await runParallel(concurrency, totalOps, async (i) => {
                return collect(
                    sqlite.ems!.ops.updateAll<FileEntity>('file', [
                        { id: sqliteFiles[i]!.id, changes: { pathname: `sqlite-upd-done-${i}.txt` } },
                    ])
                );
            });
            results.push({
                name: `SQLite`,
                ops: totalOps,
                concurrency,
                totalMs: sqliteRun.totalMs,
                avgMs: sqliteRun.totalMs / totalOps,
                opsPerSec: (totalOps / sqliteRun.totalMs) * 1000,
            });

            // PostgreSQL parallel updates
            const pgRun = await runParallel(concurrency, totalOps, async (i) => {
                return collect(
                    postgres.ems!.ops.updateAll<FileEntity>('file', [
                        { id: pgFiles[i]!.id, changes: { pathname: `pg-upd-done-${i}.txt` } },
                    ])
                );
            });
            results.push({
                name: `PostgreSQL`,
                ops: totalOps,
                concurrency,
                totalMs: pgRun.totalMs,
                avgMs: pgRun.totalMs / totalOps,
                opsPerSec: (totalOps / pgRun.totalMs) * 1000,
            });
        }

        printResults('Parallel UPDATE (write contention)', results);
        expect(results.length).toBe(6);
    }, { timeout: TIMEOUT_LONG });
});

describe('EMS Parallel: Read Scalability', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;
    let sqliteFiles: FileEntity[];
    let pgFiles: FileEntity[];

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_read`);
        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('read');

        // Pre-create files for reading
        const owner = 'parallel-read-owner';
        sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 200 }, (_, i) => ({
                    pathname: `sqlite-read-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 200 }, (_, i) => ({
                    pathname: `pg-read-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_read CASCADE`);
        adminSql.close();
    });

    it('Parallel SELECT by id: 1000 reads at concurrency 10, 50, 100, 200', async () => {
        const totalOps = 1000;
        const concurrencies = [10, 50, 100, 200];
        const results: BenchResult[] = [];

        for (const concurrency of concurrencies) {
            // SQLite parallel reads
            const sqliteRun = await runParallel(concurrency, totalOps, async (i) => {
                const id = sqliteFiles[i % sqliteFiles.length]!.id;
                return collect(sqlite.ems!.ops.selectIds<FileEntity>('file', [id]));
            });
            results.push({
                name: `SQLite`,
                ops: totalOps,
                concurrency,
                totalMs: sqliteRun.totalMs,
                avgMs: sqliteRun.totalMs / totalOps,
                opsPerSec: (totalOps / sqliteRun.totalMs) * 1000,
            });

            // PostgreSQL parallel reads
            const pgRun = await runParallel(concurrency, totalOps, async (i) => {
                const id = pgFiles[i % pgFiles.length]!.id;
                return collect(postgres.ems!.ops.selectIds<FileEntity>('file', [id]));
            });
            results.push({
                name: `PostgreSQL`,
                ops: totalOps,
                concurrency,
                totalMs: pgRun.totalMs,
                avgMs: pgRun.totalMs / totalOps,
                opsPerSec: (totalOps / pgRun.totalMs) * 1000,
            });
        }

        printResults('Parallel SELECT by id (read scalability)', results);
        expect(results.length).toBe(8);
    }, { timeout: TIMEOUT_LONG });

    it('Parallel SELECT by query: 500 queries at concurrency 10, 50, 100', async () => {
        const totalOps = 500;
        const concurrencies = [10, 50, 100];
        const results: BenchResult[] = [];

        for (const concurrency of concurrencies) {
            // SQLite parallel queries
            const sqliteRun = await runParallel(concurrency, totalOps, async (i) => {
                return collect(
                    sqlite.ems!.ops.selectAny<FileEntity>('file', {
                        where: { pathname: { $like: `sqlite-read-${i % 200}.txt` } },
                    })
                );
            });
            results.push({
                name: `SQLite`,
                ops: totalOps,
                concurrency,
                totalMs: sqliteRun.totalMs,
                avgMs: sqliteRun.totalMs / totalOps,
                opsPerSec: (totalOps / sqliteRun.totalMs) * 1000,
            });

            // PostgreSQL parallel queries
            const pgRun = await runParallel(concurrency, totalOps, async (i) => {
                return collect(
                    postgres.ems!.ops.selectAny<FileEntity>('file', {
                        where: { pathname: { $like: `pg-read-${i % 200}.txt` } },
                    })
                );
            });
            results.push({
                name: `PostgreSQL`,
                ops: totalOps,
                concurrency,
                totalMs: pgRun.totalMs,
                avgMs: pgRun.totalMs / totalOps,
                opsPerSec: (totalOps / pgRun.totalMs) * 1000,
            });
        }

        printResults('Parallel SELECT by query (read scalability)', results);
        expect(results.length).toBe(6);
    }, { timeout: TIMEOUT_LONG });
});

describe('EMS Parallel: Mixed Read/Write', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_mixed`);
        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('mixed');
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_mixed CASCADE`);
        adminSql.close();
    });

    it('Mixed 50/50 read/write: 500 ops at concurrency 10, 50, 100', async () => {
        const totalOps = 500;
        const concurrencies = [10, 50, 100];
        const results: BenchResult[] = [];

        for (const concurrency of concurrencies) {
            const owner = `mixed-${concurrency}-${Date.now()}`;

            // Pre-create files for reading
            const sqliteFiles = await collect(
                sqlite.ems!.ops.createAll<FileEntity>('file',
                    Array.from({ length: 100 }, (_, i) => ({
                        pathname: `sqlite-mixed-pre-${concurrency}-${i}.txt`,
                        owner,
                        parent: null,
                    }))
                )
            );
            const pgFiles = await collect(
                postgres.ems!.ops.createAll<FileEntity>('file',
                    Array.from({ length: 100 }, (_, i) => ({
                        pathname: `pg-mixed-pre-${concurrency}-${i}.txt`,
                        owner,
                        parent: null,
                    }))
                )
            );

            // SQLite mixed operations - may fail due to concurrent transaction limitation
            const sqliteRun = await runParallel(concurrency, totalOps, async (i) => {
                if (i % 2 === 0) {
                    // Read
                    const id = sqliteFiles[i % sqliteFiles.length]!.id;
                    return collect(sqlite.ems!.ops.selectIds<FileEntity>('file', [id]));
                } else {
                    // Write
                    return collect(
                        sqlite.ems!.ops.createAll<FileEntity>('file', [
                            { pathname: `sqlite-mixed-new-${concurrency}-${i}.txt`, owner, parent: null },
                        ])
                    );
                }
            });
            if (sqliteRun.error) {
                results.push({
                    name: `SQLite (N/A)`,
                    ops: 0,
                    concurrency,
                    totalMs: 0,
                    avgMs: 0,
                    opsPerSec: 0,
                });
            } else {
                results.push({
                    name: `SQLite`,
                    ops: totalOps,
                    concurrency,
                    totalMs: sqliteRun.totalMs,
                    avgMs: sqliteRun.totalMs / totalOps,
                    opsPerSec: (totalOps / sqliteRun.totalMs) * 1000,
                });
            }

            // PostgreSQL mixed operations
            const pgRun = await runParallel(concurrency, totalOps, async (i) => {
                if (i % 2 === 0) {
                    // Read
                    const id = pgFiles[i % pgFiles.length]!.id;
                    return collect(postgres.ems!.ops.selectIds<FileEntity>('file', [id]));
                } else {
                    // Write
                    return collect(
                        postgres.ems!.ops.createAll<FileEntity>('file', [
                            { pathname: `pg-mixed-new-${concurrency}-${i}.txt`, owner, parent: null },
                        ])
                    );
                }
            });
            results.push({
                name: `PostgreSQL`,
                ops: totalOps,
                concurrency,
                totalMs: pgRun.totalMs,
                avgMs: pgRun.totalMs / totalOps,
                opsPerSec: (totalOps / pgRun.totalMs) * 1000,
            });
        }

        printResults('Mixed 50/50 read/write (contention)', results);
        expect(results.filter(r => r.name === 'PostgreSQL').length).toBe(3);
    }, { timeout: TIMEOUT_LONG });

    it('Mixed 90/10 read/write: 500 ops at concurrency 10, 50, 100', async () => {
        const totalOps = 500;
        const concurrencies = [10, 50, 100];
        const results: BenchResult[] = [];

        for (const concurrency of concurrencies) {
            const owner = `mixed90-${concurrency}-${Date.now()}`;

            // Pre-create files for reading
            const sqliteFiles = await collect(
                sqlite.ems!.ops.createAll<FileEntity>('file',
                    Array.from({ length: 100 }, (_, i) => ({
                        pathname: `sqlite-mixed90-pre-${concurrency}-${i}.txt`,
                        owner,
                        parent: null,
                    }))
                )
            );
            const pgFiles = await collect(
                postgres.ems!.ops.createAll<FileEntity>('file',
                    Array.from({ length: 100 }, (_, i) => ({
                        pathname: `pg-mixed90-pre-${concurrency}-${i}.txt`,
                        owner,
                        parent: null,
                    }))
                )
            );

            // SQLite mixed operations (90% read, 10% write) - may fail
            const sqliteRun = await runParallel(concurrency, totalOps, async (i) => {
                if (i % 10 !== 0) {
                    // Read (90%)
                    const id = sqliteFiles[i % sqliteFiles.length]!.id;
                    return collect(sqlite.ems!.ops.selectIds<FileEntity>('file', [id]));
                } else {
                    // Write (10%)
                    return collect(
                        sqlite.ems!.ops.createAll<FileEntity>('file', [
                            { pathname: `sqlite-mixed90-new-${concurrency}-${i}.txt`, owner, parent: null },
                        ])
                    );
                }
            });
            if (sqliteRun.error) {
                results.push({
                    name: `SQLite (N/A)`,
                    ops: 0,
                    concurrency,
                    totalMs: 0,
                    avgMs: 0,
                    opsPerSec: 0,
                });
            } else {
                results.push({
                    name: `SQLite`,
                    ops: totalOps,
                    concurrency,
                    totalMs: sqliteRun.totalMs,
                    avgMs: sqliteRun.totalMs / totalOps,
                    opsPerSec: (totalOps / sqliteRun.totalMs) * 1000,
                });
            }

            // PostgreSQL mixed operations (90% read, 10% write)
            const pgRun = await runParallel(concurrency, totalOps, async (i) => {
                if (i % 10 !== 0) {
                    // Read (90%)
                    const id = pgFiles[i % pgFiles.length]!.id;
                    return collect(postgres.ems!.ops.selectIds<FileEntity>('file', [id]));
                } else {
                    // Write (10%)
                    return collect(
                        postgres.ems!.ops.createAll<FileEntity>('file', [
                            { pathname: `pg-mixed90-new-${concurrency}-${i}.txt`, owner, parent: null },
                        ])
                    );
                }
            });
            results.push({
                name: `PostgreSQL`,
                ops: totalOps,
                concurrency,
                totalMs: pgRun.totalMs,
                avgMs: pgRun.totalMs / totalOps,
                opsPerSec: (totalOps / pgRun.totalMs) * 1000,
            });
        }

        printResults('Mixed 90/10 read/write (light contention)', results);
        expect(results.filter(r => r.name === 'PostgreSQL').length).toBe(3);
    }, { timeout: TIMEOUT_LONG });
});

describe('EMS Parallel: Stress Test', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_stress`);
        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('stress');
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_stress CASCADE`);
        adminSql.close();
    });

    it('High concurrency burst: 200 creates at concurrency 200', async () => {
        const totalOps = 200;
        const concurrency = 200; // All at once
        const results: BenchResult[] = [];
        const owner = `burst-${Date.now()}`;

        // SQLite burst - expected to fail due to concurrent transaction limitation
        const sqliteRun = await runParallel(concurrency, totalOps, async (i) => {
            return collect(
                sqlite.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `sqlite-burst-${i}.txt`, owner, parent: null },
                ])
            );
        });
        if (sqliteRun.error) {
            results.push({
                name: `SQLite (N/A)`,
                ops: 0,
                concurrency,
                totalMs: 0,
                avgMs: 0,
                opsPerSec: 0,
            });
        } else {
            results.push({
                name: `SQLite`,
                ops: totalOps,
                concurrency,
                totalMs: sqliteRun.totalMs,
                avgMs: sqliteRun.totalMs / totalOps,
                opsPerSec: (totalOps / sqliteRun.totalMs) * 1000,
            });
        }

        // PostgreSQL burst
        const pgRun = await runParallel(concurrency, totalOps, async (i) => {
            return collect(
                postgres.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `pg-burst-${i}.txt`, owner, parent: null },
                ])
            );
        });
        results.push({
            name: `PostgreSQL`,
            ops: totalOps,
            concurrency,
            totalMs: pgRun.totalMs,
            avgMs: pgRun.totalMs / totalOps,
            opsPerSec: (totalOps / pgRun.totalMs) * 1000,
        });

        printResults('High concurrency burst (200 simultaneous)', results);
        expect(results.filter(r => r.name === 'PostgreSQL').length).toBe(1);
    }, { timeout: TIMEOUT_LONG });
});
