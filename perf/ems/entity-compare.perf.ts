/**
 * EMS Entity Performance Comparison: SQLite vs PostgreSQL
 *
 * Compares File & Folder entity operations through the EMS observer pipeline:
 * - Single entity operations (create, read, update, delete)
 * - Bulk operations (batch create, select)
 * - Mixed workloads (CRUD cycles)
 * - Hierarchical operations (nested folders, files in folders)
 *
 * This tests the FULL observer pipeline (8 rings) unlike HAL storage tests.
 *
 * Run with: bun test ./perf/ems/entity-compare.perf.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import { collect } from '@src/ems/entity-ops.js';
import type { HALConfig } from '@src/hal/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TIMEOUT_MEDIUM = 60_000;
const TIMEOUT_LONG = 120_000;

// PostgreSQL connection
const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgresql://localhost/monk_os';

// Test schema for PostgreSQL isolation
const PG_SCHEMA = `ems_perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// =============================================================================
// TYPES
// =============================================================================

interface BenchResult {
    name: string;
    ops: number;
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
    data?: string;
    size?: number;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
    [key: string]: unknown;
}

interface FolderEntity {
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
    const perSec = (count / ms) * 1000;
    return `${perSec.toFixed(0)} ops/sec`;
}

function formatTime(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
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

async function runBench<T>(
    name: string,
    stack: OsStack,
    ops: number,
    fn: (stack: OsStack, i: number) => Promise<T>
): Promise<BenchResult> {
    const start = performance.now();
    for (let i = 0; i < ops; i++) {
        await fn(stack, i);
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
// STACK CREATION HELPERS
// =============================================================================

async function createSqliteStack(): Promise<OsStack> {
    return createOsStack({
        hal: { storage: { type: 'memory' } }, // SQLite in-memory
        ems: true,
    });
}

async function createPostgresStack(): Promise<OsStack> {
    const config: HALConfig = {
        storage: { type: 'postgres', url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}` },
    };
    return createOsStack({
        hal: config,
        ems: true,
    });
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('EMS Entity Compare: File Operations', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        // Setup PostgreSQL schema
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);

        // Create stacks
        sqlite = await createSqliteStack();
        postgres = await createPostgresStack();
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
        adminSql.close();
    });

    it('CREATE: 500 files (single ops)', async () => {
        const count = 500;
        const owner = `bench-${Date.now()}`;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (stack, i) => {
            await collect(
                stack.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `sqlite-file-${i}.txt`, owner, parent: null },
                ])
            );
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (stack, i) => {
            await collect(
                stack.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `pg-file-${i}.txt`, owner, parent: null },
                ])
            );
        });

        console.log('\nCREATE 500 files (single ops):');
        printResults([sqliteResult, pgResult]);
        expect(sqliteResult.totalMs).toBeLessThan(30000);
        expect(pgResult.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });

    it('SELECT: 500 file lookups by id', async () => {
        const count = 500;
        const owner = `bench-select-${Date.now()}`;

        // Pre-create files
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 100 }, (_, i) => ({
                    pathname: `sqlite-lookup-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 100 }, (_, i) => ({
                    pathname: `pg-lookup-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteResult = await runBench('SQLite', sqlite, count, async (stack, i) => {
            const id = sqliteFiles[i % sqliteFiles.length]!.id;
            await collect(stack.ems!.ops.selectIds<FileEntity>('file', [id]));
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (stack, i) => {
            const id = pgFiles[i % pgFiles.length]!.id;
            await collect(stack.ems!.ops.selectIds<FileEntity>('file', [id]));
        });

        console.log('\nSELECT 500 file lookups by id:');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('UPDATE: 500 file metadata updates', async () => {
        const count = 500;
        const owner = `bench-update-${Date.now()}`;

        // Pre-create files
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 100 }, (_, i) => ({
                    pathname: `sqlite-update-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 100 }, (_, i) => ({
                    pathname: `pg-update-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteResult = await runBench('SQLite', sqlite, count, async (stack, i) => {
            const id = sqliteFiles[i % sqliteFiles.length]!.id;
            await collect(
                stack.ems!.ops.updateAll<FileEntity>('file', [
                    { id, changes: { pathname: `sqlite-updated-${i}.txt` } },
                ])
            );
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (stack, i) => {
            const id = pgFiles[i % pgFiles.length]!.id;
            await collect(
                stack.ems!.ops.updateAll<FileEntity>('file', [
                    { id, changes: { pathname: `pg-updated-${i}.txt` } },
                ])
            );
        });

        console.log('\nUPDATE 500 file metadata updates:');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });

    it('DELETE: 200 file soft deletes', async () => {
        const count = 200;
        const owner = `bench-delete-${Date.now()}`;

        // Pre-create files to delete
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `sqlite-delete-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `pg-delete-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteResult = await runBench('SQLite', sqlite, count, async (stack, i) => {
            const id = sqliteFiles[i]!.id;
            await collect(stack.ems!.ops.deleteIds('file', [id]));
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (stack, i) => {
            const id = pgFiles[i]!.id;
            await collect(stack.ems!.ops.deleteIds('file', [id]));
        });

        console.log('\nDELETE 200 file soft deletes:');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('EMS Entity Compare: Folder Operations', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_folder`);

        sqlite = await createSqliteStack();
        postgres = await createOsStack({
            hal: { storage: { type: 'postgres', url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_folder` } },
            ems: true,
        });
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_folder CASCADE`);
        adminSql.close();
    });

    it('CREATE: 500 folders (single ops)', async () => {
        const count = 500;
        const owner = `bench-${Date.now()}`;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (stack, i) => {
            await collect(
                stack.ems!.ops.createAll<FolderEntity>('folder', [
                    { pathname: `sqlite-folder-${i}`, owner, parent: null },
                ])
            );
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (stack, i) => {
            await collect(
                stack.ems!.ops.createAll<FolderEntity>('folder', [
                    { pathname: `pg-folder-${i}`, owner, parent: null },
                ])
            );
        });

        console.log('\nCREATE 500 folders (single ops):');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_LONG });

    it('CREATE: Nested folder hierarchy (5 levels x 10 folders)', async () => {
        const owner = `bench-nested-${Date.now()}`;

        async function createNestedFolders(stack: OsStack, prefix: string): Promise<number> {
            let count = 0;
            let parentIds: (string | null)[] = [null];

            for (let level = 0; level < 5; level++) {
                const newParentIds: string[] = [];
                for (const parentId of parentIds) {
                    for (let i = 0; i < 10; i++) {
                        const folders = await collect(
                            stack.ems!.ops.createAll<FolderEntity>('folder', [
                                { pathname: `${prefix}-L${level}-${i}`, owner, parent: parentId },
                            ])
                        );
                        if (level < 4) {
                            newParentIds.push(folders[0]!.id);
                        }
                        count++;
                    }
                }
                parentIds = newParentIds.slice(0, 10); // Limit branching
            }
            return count;
        }

        const sqliteStart = performance.now();
        const sqliteCount = await createNestedFolders(sqlite, 'sqlite');
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        const pgCount = await createNestedFolders(postgres, 'pg');
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: sqliteCount, totalMs: sqliteMs, avgMs: sqliteMs / sqliteCount, opsPerSec: (sqliteCount / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: pgCount, totalMs: pgMs, avgMs: pgMs / pgCount, opsPerSec: (pgCount / pgMs) * 1000 },
        ];

        console.log('\nNested folder hierarchy (5 levels):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });
});

describe('EMS Entity Compare: Bulk Operations', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_bulk`);

        sqlite = await createSqliteStack();
        postgres = await createOsStack({
            hal: { storage: { type: 'postgres', url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_bulk` } },
            ems: true,
        });
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_bulk CASCADE`);
        adminSql.close();
    });

    it('BATCH CREATE: 1000 files in single batch', async () => {
        const count = 1000;
        const owner = `bench-batch-${Date.now()}`;

        const sqliteStart = performance.now();
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `sqlite-batch-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `pg-batch-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgMs = performance.now() - pgStart;

        expect(sqliteFiles).toHaveLength(count);
        expect(pgFiles).toHaveLength(count);

        const results: BenchResult[] = [
            { name: 'SQLite', ops: count, totalMs: sqliteMs, avgMs: sqliteMs / count, opsPerSec: (count / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: count, totalMs: pgMs, avgMs: pgMs / count, opsPerSec: (count / pgMs) * 1000 },
        ];

        console.log('\nBATCH CREATE 1000 files:');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });

    it('BATCH SELECT: Query 1000 files by owner', async () => {
        const owner = `bench-batch-${Date.now()}`;
        const count = 1000;

        // Pre-create
        await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `sqlite-query-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `pg-query-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const iterations = 10;

        const sqliteStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const files = await collect(
                sqlite.ems!.ops.selectAny<FileEntity>('file', { where: { owner } })
            );
            expect(files.length).toBe(count);
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const files = await collect(
                postgres.ems!.ops.selectAny<FileEntity>('file', { where: { owner } })
            );
            expect(files.length).toBe(count);
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: iterations, totalMs: sqliteMs, avgMs: sqliteMs / iterations, opsPerSec: (iterations / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: iterations, totalMs: pgMs, avgMs: pgMs / iterations, opsPerSec: (iterations / pgMs) * 1000 },
        ];

        console.log('\nBATCH SELECT 1000 files x 10 iterations:');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });

    it('BATCH UPDATE: 500 files in single batch', async () => {
        const owner = `bench-batch-upd-${Date.now()}`;
        const count = 500;

        // Pre-create
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `sqlite-bupd-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `pg-bupd-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteStart = performance.now();
        await collect(
            sqlite.ems!.ops.updateAll<FileEntity>('file',
                sqliteFiles.map((f, i) => ({ id: f.id, changes: { pathname: `sqlite-bupd-updated-${i}.txt` } }))
            )
        );
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        await collect(
            postgres.ems!.ops.updateAll<FileEntity>('file',
                pgFiles.map((f, i) => ({ id: f.id, changes: { pathname: `pg-bupd-updated-${i}.txt` } }))
            )
        );
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: count, totalMs: sqliteMs, avgMs: sqliteMs / count, opsPerSec: (count / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: count, totalMs: pgMs, avgMs: pgMs / count, opsPerSec: (count / pgMs) * 1000 },
        ];

        console.log('\nBATCH UPDATE 500 files:');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });

    it('BATCH DELETE: 500 files in single batch', async () => {
        const owner = `bench-batch-del-${Date.now()}`;
        const count = 500;

        // Pre-create
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `sqlite-bdel-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count }, (_, i) => ({
                    pathname: `pg-bdel-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteStart = performance.now();
        await collect(
            sqlite.ems!.ops.deleteIds('file', sqliteFiles.map(f => f.id))
        );
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        await collect(
            postgres.ems!.ops.deleteIds('file', pgFiles.map(f => f.id))
        );
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: count, totalMs: sqliteMs, avgMs: sqliteMs / count, opsPerSec: (count / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: count, totalMs: pgMs, avgMs: pgMs / count, opsPerSec: (count / pgMs) * 1000 },
        ];

        console.log('\nBATCH DELETE 500 files:');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });
});

describe('EMS Entity Compare: Mixed Workload', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_mixed`);

        sqlite = await createSqliteStack();
        postgres = await createOsStack({
            hal: { storage: { type: 'postgres', url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_mixed` } },
            ems: true,
        });

        // Pre-populate with files
        const owner = 'mixed-owner';
        await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 200 }, (_, i) => ({
                    pathname: `sqlite-mixed-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 200 }, (_, i) => ({
                    pathname: `pg-mixed-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_mixed CASCADE`);
        adminSql.close();
    });

    it('CRUD cycle: 200 create-read-update-delete cycles', async () => {
        const cycles = 200;
        const owner = `crud-${Date.now()}`;

        const sqliteStart = performance.now();
        for (let i = 0; i < cycles; i++) {
            // Create
            const created = await collect(
                sqlite.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `sqlite-crud-${i}.txt`, owner, parent: null },
                ])
            );
            const id = created[0]!.id;

            // Read
            await collect(sqlite.ems!.ops.selectIds<FileEntity>('file', [id]));

            // Update
            await collect(
                sqlite.ems!.ops.updateAll<FileEntity>('file', [
                    { id, changes: { pathname: `sqlite-crud-updated-${i}.txt` } },
                ])
            );

            // Delete
            await collect(sqlite.ems!.ops.deleteIds('file', [id]));
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < cycles; i++) {
            // Create
            const created = await collect(
                postgres.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `pg-crud-${i}.txt`, owner, parent: null },
                ])
            );
            const id = created[0]!.id;

            // Read
            await collect(postgres.ems!.ops.selectIds<FileEntity>('file', [id]));

            // Update
            await collect(
                postgres.ems!.ops.updateAll<FileEntity>('file', [
                    { id, changes: { pathname: `pg-crud-updated-${i}.txt` } },
                ])
            );

            // Delete
            await collect(postgres.ems!.ops.deleteIds('file', [id]));
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = cycles * 4; // 4 ops per cycle
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / cycles, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / cycles, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nCRUD cycle (200 x create-read-update-delete):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });

    it('Read-heavy: 95% reads, 5% writes', async () => {
        const totalOps = 500;
        const owner = `read-heavy-${Date.now()}`;

        // Pre-create files for reading
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 50 }, (_, i) => ({
                    pathname: `sqlite-rh-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 50 }, (_, i) => ({
                    pathname: `pg-rh-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.95) {
                const id = sqliteFiles[i % sqliteFiles.length]!.id;
                await collect(sqlite.ems!.ops.selectIds<FileEntity>('file', [id]));
            } else {
                await collect(
                    sqlite.ems!.ops.createAll<FileEntity>('file', [
                        { pathname: `sqlite-rh-new-${i}.txt`, owner, parent: null },
                    ])
                );
            }
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.95) {
                const id = pgFiles[i % pgFiles.length]!.id;
                await collect(postgres.ems!.ops.selectIds<FileEntity>('file', [id]));
            } else {
                await collect(
                    postgres.ems!.ops.createAll<FileEntity>('file', [
                        { pathname: `pg-rh-new-${i}.txt`, owner, parent: null },
                    ])
                );
            }
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nRead-heavy (95% reads, 5% writes):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });

    it('Write-heavy: 5% reads, 95% writes', async () => {
        const totalOps = 500;
        const owner = `write-heavy-${Date.now()}`;

        // Pre-create files for reading
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 50 }, (_, i) => ({
                    pathname: `sqlite-wh-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: 50 }, (_, i) => ({
                    pathname: `pg-wh-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.05) {
                const id = sqliteFiles[i % sqliteFiles.length]!.id;
                await collect(sqlite.ems!.ops.selectIds<FileEntity>('file', [id]));
            } else {
                await collect(
                    sqlite.ems!.ops.createAll<FileEntity>('file', [
                        { pathname: `sqlite-wh-new-${i}.txt`, owner, parent: null },
                    ])
                );
            }
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < totalOps; i++) {
            if (Math.random() < 0.05) {
                const id = pgFiles[i % pgFiles.length]!.id;
                await collect(postgres.ems!.ops.selectIds<FileEntity>('file', [id]));
            } else {
                await collect(
                    postgres.ems!.ops.createAll<FileEntity>('file', [
                        { pathname: `pg-wh-new-${i}.txt`, owner, parent: null },
                    ])
                );
            }
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nWrite-heavy (5% reads, 95% writes):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });
});

describe('EMS Entity Compare: Files in Folders', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;
    let sqliteFolders: FolderEntity[];
    let pgFolders: FolderEntity[];

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_hierarchy`);

        sqlite = await createSqliteStack();
        postgres = await createOsStack({
            hal: { storage: { type: 'postgres', url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_hierarchy` } },
            ems: true,
        });

        // Pre-create folder structure
        const owner = 'hierarchy-owner';
        sqliteFolders = await collect(
            sqlite.ems!.ops.createAll<FolderEntity>('folder',
                Array.from({ length: 10 }, (_, i) => ({
                    pathname: `sqlite-folder-${i}`,
                    owner,
                    parent: null,
                }))
            )
        );
        pgFolders = await collect(
            postgres.ems!.ops.createAll<FolderEntity>('folder',
                Array.from({ length: 10 }, (_, i) => ({
                    pathname: `pg-folder-${i}`,
                    owner,
                    parent: null,
                }))
            )
        );
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_hierarchy CASCADE`);
        adminSql.close();
    });

    it('CREATE: 500 files distributed across 10 folders', async () => {
        const count = 500;
        const owner = `hierarchy-${Date.now()}`;

        const sqliteResult = await runBench('SQLite', sqlite, count, async (stack, i) => {
            const folderId = sqliteFolders[i % 10]!.id;
            await collect(
                stack.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `sqlite-hier-${i}.txt`, owner, parent: folderId },
                ])
            );
        });

        const pgResult = await runBench('PostgreSQL', postgres, count, async (stack, i) => {
            const folderId = pgFolders[i % 10]!.id;
            await collect(
                stack.ems!.ops.createAll<FileEntity>('file', [
                    { pathname: `pg-hier-${i}.txt`, owner, parent: folderId },
                ])
            );
        });

        console.log('\nCREATE 500 files in 10 folders:');
        printResults([sqliteResult, pgResult]);
    }, { timeout: TIMEOUT_LONG });

    it('SELECT: Files by parent folder (10 queries x 10 folders)', async () => {
        const iterations = 10;

        const sqliteStart = performance.now();
        for (let iter = 0; iter < iterations; iter++) {
            for (const folder of sqliteFolders) {
                await collect(
                    sqlite.ems!.ops.selectAny<FileEntity>('file', { where: { parent: folder.id } })
                );
            }
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let iter = 0; iter < iterations; iter++) {
            for (const folder of pgFolders) {
                await collect(
                    postgres.ems!.ops.selectAny<FileEntity>('file', { where: { parent: folder.id } })
                );
            }
        }
        const pgMs = performance.now() - pgStart;

        const totalOps = iterations * 10;
        const results: BenchResult[] = [
            { name: 'SQLite', ops: totalOps, totalMs: sqliteMs, avgMs: sqliteMs / totalOps, opsPerSec: (totalOps / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: totalOps, totalMs: pgMs, avgMs: pgMs / totalOps, opsPerSec: (totalOps / pgMs) * 1000 },
        ];

        console.log('\nSELECT files by parent (100 queries):');
        printResults(results);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('EMS Entity Compare: Upsert Operations', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_upsert`);

        sqlite = await createSqliteStack();
        postgres = await createOsStack({
            hal: { storage: { type: 'postgres', url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}_upsert` } },
            ems: true,
        });
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_upsert CASCADE`);
        adminSql.close();
    });

    it('UPSERT: 500 ops (50% inserts, 50% updates)', async () => {
        const count = 500;
        const owner = `upsert-${Date.now()}`;

        // Pre-create some files for updates
        const sqliteFiles = await collect(
            sqlite.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count / 2 }, (_, i) => ({
                    pathname: `sqlite-upsert-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );
        const pgFiles = await collect(
            postgres.ems!.ops.createAll<FileEntity>('file',
                Array.from({ length: count / 2 }, (_, i) => ({
                    pathname: `pg-upsert-${i}.txt`,
                    owner,
                    parent: null,
                }))
            )
        );

        const sqliteStart = performance.now();
        for (let i = 0; i < count; i++) {
            if (i < count / 2) {
                // Update existing
                await collect(
                    sqlite.ems!.ops.upsertAll<FileEntity>('file', [
                        { id: sqliteFiles[i]!.id, pathname: `sqlite-upserted-${i}.txt`, owner, parent: null },
                    ])
                );
            } else {
                // Insert new
                await collect(
                    sqlite.ems!.ops.upsertAll<FileEntity>('file', [
                        { pathname: `sqlite-upsert-new-${i}.txt`, owner, parent: null },
                    ])
                );
            }
        }
        const sqliteMs = performance.now() - sqliteStart;

        const pgStart = performance.now();
        for (let i = 0; i < count; i++) {
            if (i < count / 2) {
                // Update existing
                await collect(
                    postgres.ems!.ops.upsertAll<FileEntity>('file', [
                        { id: pgFiles[i]!.id, pathname: `pg-upserted-${i}.txt`, owner, parent: null },
                    ])
                );
            } else {
                // Insert new
                await collect(
                    postgres.ems!.ops.upsertAll<FileEntity>('file', [
                        { pathname: `pg-upsert-new-${i}.txt`, owner, parent: null },
                    ])
                );
            }
        }
        const pgMs = performance.now() - pgStart;

        const results: BenchResult[] = [
            { name: 'SQLite', ops: count, totalMs: sqliteMs, avgMs: sqliteMs / count, opsPerSec: (count / sqliteMs) * 1000 },
            { name: 'PostgreSQL', ops: count, totalMs: pgMs, avgMs: pgMs / count, opsPerSec: (count / pgMs) * 1000 },
        ];

        console.log('\nUPSERT 500 ops (50% insert, 50% update):');
        printResults(results);
    }, { timeout: TIMEOUT_LONG });
});
