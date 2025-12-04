/**
 * EMS Passthrough Performance Comparison
 *
 * Compares entity operations with passthrough=1 (skip observer pipeline)
 * versus passthrough=0 (full 8-ring observer pipeline).
 *
 * This quantifies the overhead of the observer pipeline for high-throughput
 * scenarios where validation/transforms are not needed.
 *
 * Run with: bun test ./perf/ems/passthrough-compare.perf.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createOsStack, type OsStack } from '@src/os/stack.js';
import { collect } from '@src/ems/entity-ops.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TIMEOUT_LONG = 120_000;

// PostgreSQL connection
const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgresql://localhost/monk_os';

// Test schema for PostgreSQL isolation
const PG_SCHEMA = `passthrough_perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Test sizes
const SERIAL_OPS = 500;
const PARALLEL_OPS = 500;
const CONCURRENCY_LEVELS = [10, 50, 100];

// =============================================================================
// TYPES
// =============================================================================

interface BenchResult {
    name: string;
    ops: number;
    totalMs: number;
    avgMicros: number;
    opsPerSec: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatTable(results: BenchResult[]): void {
    console.log('\n┌─────────────────────┬──────────┬────────────┬──────────┬────────────┐');
    console.log('│ Mode                │ Ops      │ Total      │ Avg/Op   │ Throughput │');
    console.log('├─────────────────────┼──────────┼────────────┼──────────┼────────────┤');

    for (const r of results) {
        const name = r.name.padEnd(19);
        const ops = r.ops.toString().padStart(8);
        const total = `${r.totalMs.toFixed(2)}ms`.padStart(10);
        const avg = `${r.avgMicros.toFixed(0)}μs`.padStart(8);
        const throughput = `${r.opsPerSec.toFixed(0)} ops/sec`.padStart(10);
        console.log(`│ ${name} │ ${ops} │ ${total} │ ${avg} │ ${throughput} │`);
    }

    console.log('└─────────────────────┴──────────┴────────────┴──────────┴────────────┘');
}

async function benchmark(
    name: string,
    ops: number,
    fn: () => Promise<void>
): Promise<BenchResult> {
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;

    return {
        name,
        ops,
        totalMs: elapsed,
        avgMicros: (elapsed / ops) * 1000,
        opsPerSec: (ops / elapsed) * 1000,
    };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Passthrough vs Pipeline Performance', () => {
    let sqliteStack: OsStack;
    let pgStack: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    // Model names
    const NORMAL_MODEL = 'perf_normal';
    const PASSTHROUGH_MODEL = 'perf_passthrough';
    const HEAVY_MODEL = 'perf_heavy';

    beforeAll(async () => {
        // Create PostgreSQL schema first
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);

        // Create SQLite stack
        sqliteStack = await createOsStack({
            hal: { storage: { type: 'memory' } },
            ems: true,
        });

        // Create PostgreSQL stack
        pgStack = await createOsStack({
            hal: {
                storage: {
                    type: 'postgres',
                    url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}`,
                },
            },
            ems: true,
        });

        // Create test models on both stacks
        for (const stack of [sqliteStack, pgStack]) {
            // Create normal model (passthrough=false)
            await collect(stack.entityOps!.createAll('models', [{
                model_name: NORMAL_MODEL,
                status: 'active',
                description: 'Normal model with full observer pipeline',
                passthrough: false,
            }]));

            // Create passthrough model (passthrough=true)
            await collect(stack.entityOps!.createAll('models', [{
                model_name: PASSTHROUGH_MODEL,
                status: 'active',
                description: 'Passthrough model - skips observer pipeline',
                passthrough: true,
            }]));

            // Create fields for both simple models
            for (const modelName of [NORMAL_MODEL, PASSTHROUGH_MODEL]) {
                await collect(stack.entityOps!.createAll('fields', [
                    { model_name: modelName, field_name: 'name', type: 'text', required: true },
                    { model_name: modelName, field_name: 'value', type: 'integer', required: false },
                    { model_name: modelName, field_name: 'data', type: 'text', required: false },
                ]));
            }

            // Create heavy model with lots of validation
            await collect(stack.entityOps!.createAll('models', [{
                model_name: HEAVY_MODEL,
                status: 'active',
                description: 'Heavy model with constraints, transforms, and tracking',
                passthrough: false,
            }]));

            // Heavy model fields with constraints and tracking
            await collect(stack.entityOps!.createAll('fields', [
                // Required text with pattern (email-like)
                {
                    model_name: HEAVY_MODEL,
                    field_name: 'email',
                    type: 'text',
                    required: true,
                    pattern: '^[a-z0-9._%+-]+@[a-z0-9.-]+$',
                    transform: 'lowercase',
                    tracked: true,
                },
                // Required text with enum
                {
                    model_name: HEAVY_MODEL,
                    field_name: 'status',
                    type: 'text',
                    required: true,
                    enum_values: '["draft","pending","active","closed"]',
                    tracked: true,
                },
                // Required integer with min/max
                {
                    model_name: HEAVY_MODEL,
                    field_name: 'priority',
                    type: 'integer',
                    required: true,
                    minimum: 1,
                    maximum: 10,
                    tracked: true,
                },
                // Required numeric with min/max
                {
                    model_name: HEAVY_MODEL,
                    field_name: 'amount',
                    type: 'numeric',
                    required: true,
                    minimum: 0,
                    maximum: 1000000,
                    tracked: true,
                },
                // Optional text with transform
                {
                    model_name: HEAVY_MODEL,
                    field_name: 'name',
                    type: 'text',
                    required: false,
                    transform: 'trim',
                },
                // Optional boolean
                {
                    model_name: HEAVY_MODEL,
                    field_name: 'active',
                    type: 'boolean',
                    required: false,
                },
                // Optional text (no constraints)
                {
                    model_name: HEAVY_MODEL,
                    field_name: 'notes',
                    type: 'text',
                    required: false,
                },
            ]));
        }
    }, TIMEOUT_LONG);

    afterAll(async () => {
        // Cleanup
        if (adminSql) {
            try {
                await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
            } catch {
                // Ignore cleanup errors
            }
            adminSql.close();
        }
        if (pgStack) {
            await pgStack.shutdown();
        }
        if (sqliteStack) {
            await sqliteStack.shutdown();
        }
    });

    it('should compare serial CREATE performance', async () => {
        const results: BenchResult[] = [];

        for (const [label, stack] of [['SQLite', sqliteStack], ['PostgreSQL', pgStack]] as const) {
            const entityOps = stack.entityOps!;

            // Test normal model (full pipeline)
            const normalResult = await benchmark(
                `${label} Pipeline`,
                SERIAL_OPS,
                async () => {
                    for (let i = 0; i < SERIAL_OPS; i++) {
                        await collect(entityOps.createAll(NORMAL_MODEL, [{
                            name: `normal-${i}`,
                            value: i,
                            data: `payload-${i}`,
                        }]));
                    }
                }
            );
            results.push(normalResult);

            // Test passthrough model (skip pipeline)
            const passthroughResult = await benchmark(
                `${label} Passthrough`,
                SERIAL_OPS,
                async () => {
                    for (let i = 0; i < SERIAL_OPS; i++) {
                        await collect(entityOps.createAll(PASSTHROUGH_MODEL, [{
                            name: `passthrough-${i}`,
                            value: i,
                            data: `payload-${i}`,
                        }]));
                    }
                }
            );
            results.push(passthroughResult);
        }

        console.log('\nSerial CREATE (pipeline vs passthrough):');
        formatTable(results);

        // Calculate speedup
        for (let i = 0; i < results.length; i += 2) {
            const pipeline = results[i]!;
            const passthrough = results[i + 1]!;
            const speedup = pipeline.totalMs / passthrough.totalMs;
            console.log(`\n${pipeline.name.split(' ')[0]} speedup: ${speedup.toFixed(2)}x faster with passthrough`);
        }

        expect(results.length).toBe(4);
    }, TIMEOUT_LONG);

    it('should compare parallel CREATE performance', async () => {
        const allResults: BenchResult[] = [];

        for (const concurrency of CONCURRENCY_LEVELS) {
            const results: BenchResult[] = [];

            for (const [label, stack] of [['SQLite', sqliteStack], ['PostgreSQL', pgStack]] as const) {
                const entityOps = stack.entityOps!;

                // Parallel normal model
                const normalResult = await benchmark(
                    `${label} Pipeline`,
                    PARALLEL_OPS,
                    async () => {
                        const batches: Promise<void>[] = [];
                        for (let i = 0; i < PARALLEL_OPS; i++) {
                            const promise = collect(entityOps.createAll(NORMAL_MODEL, [{
                                name: `pnormal-${concurrency}-${i}`,
                                value: i,
                            }])).then(() => {});

                            batches.push(promise);

                            if (batches.length >= concurrency) {
                                await Promise.all(batches);
                                batches.length = 0;
                            }
                        }
                        if (batches.length > 0) {
                            await Promise.all(batches);
                        }
                    }
                );
                results.push(normalResult);

                // Parallel passthrough model
                const passthroughResult = await benchmark(
                    `${label} Passthrough`,
                    PARALLEL_OPS,
                    async () => {
                        const batches: Promise<void>[] = [];
                        for (let i = 0; i < PARALLEL_OPS; i++) {
                            const promise = collect(entityOps.createAll(PASSTHROUGH_MODEL, [{
                                name: `ppassthrough-${concurrency}-${i}`,
                                value: i,
                            }])).then(() => {});

                            batches.push(promise);

                            if (batches.length >= concurrency) {
                                await Promise.all(batches);
                                batches.length = 0;
                            }
                        }
                        if (batches.length > 0) {
                            await Promise.all(batches);
                        }
                    }
                );
                results.push(passthroughResult);
            }

            console.log(`\nParallel CREATE at concurrency ${concurrency}:`);
            formatTable(results);
            allResults.push(...results);
        }

        expect(allResults.length).toBe(CONCURRENCY_LEVELS.length * 4);
    }, TIMEOUT_LONG);

    it('should show overhead breakdown', async () => {
        // Quick test to show raw numbers
        const OPS = 200;
        const results: BenchResult[] = [];

        for (const [label, stack] of [['SQLite', sqliteStack], ['PostgreSQL', pgStack]] as const) {
            const db = stack.db!;
            const entityOps = stack.entityOps!;

            // Direct DB insert (baseline)
            const directResult = await benchmark(
                `${label} Direct SQL`,
                OPS,
                async () => {
                    for (let i = 0; i < OPS; i++) {
                        const id = crypto.randomUUID();
                        const now = new Date().toISOString();
                        await db.execute(
                            `INSERT INTO ${PASSTHROUGH_MODEL} (id, name, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
                            [id, `direct-${i}`, i, now, now]
                        );
                    }
                }
            );
            results.push(directResult);

            // Passthrough (EntityOps + ModelRecord, no observers)
            const passthroughResult = await benchmark(
                `${label} Passthrough`,
                OPS,
                async () => {
                    for (let i = 0; i < OPS; i++) {
                        await collect(entityOps.createAll(PASSTHROUGH_MODEL, [{
                            name: `overhead-pt-${i}`,
                            value: i,
                        }]));
                    }
                }
            );
            results.push(passthroughResult);

            // Full pipeline
            const pipelineResult = await benchmark(
                `${label} Full Pipeline`,
                OPS,
                async () => {
                    for (let i = 0; i < OPS; i++) {
                        await collect(entityOps.createAll(NORMAL_MODEL, [{
                            name: `overhead-full-${i}`,
                            value: i,
                        }]));
                    }
                }
            );
            results.push(pipelineResult);
        }

        console.log('\nOverhead breakdown (Direct SQL → Passthrough → Full Pipeline):');
        formatTable(results);

        // Calculate overhead percentages
        for (let i = 0; i < results.length; i += 3) {
            const direct = results[i]!;
            const passthrough = results[i + 1]!;
            const pipeline = results[i + 2]!;
            const label = direct.name.split(' ')[0];

            const entityOpsOverhead = ((passthrough.totalMs - direct.totalMs) / direct.totalMs) * 100;
            const pipelineOverhead = ((pipeline.totalMs - passthrough.totalMs) / passthrough.totalMs) * 100;
            const totalOverhead = ((pipeline.totalMs - direct.totalMs) / direct.totalMs) * 100;

            console.log(`\n${label} overhead:`);
            console.log(`  EntityOps/ModelRecord: +${entityOpsOverhead.toFixed(1)}%`);
            console.log(`  Observer Pipeline:     +${pipelineOverhead.toFixed(1)}%`);
            console.log(`  Total vs Direct SQL:   +${totalOverhead.toFixed(1)}%`);
        }

        expect(results.length).toBe(6);
    }, TIMEOUT_LONG);

    it('should compare light vs heavy model pipeline overhead', async () => {
        const OPS = 200;
        const results: BenchResult[] = [];

        for (const [label, stack] of [['SQLite', sqliteStack], ['PostgreSQL', pgStack]] as const) {
            const entityOps = stack.entityOps!;

            // Light model (simple fields, no constraints)
            const lightResult = await benchmark(
                `${label} Light Model`,
                OPS,
                async () => {
                    for (let i = 0; i < OPS; i++) {
                        await collect(entityOps.createAll(NORMAL_MODEL, [{
                            name: `light-${i}`,
                            value: i,
                        }]));
                    }
                }
            );
            results.push(lightResult);

            // Heavy model (constraints, transforms, tracking)
            const heavyResult = await benchmark(
                `${label} Heavy Model`,
                OPS,
                async () => {
                    const statuses = ['draft', 'pending', 'active', 'closed'];
                    for (let i = 0; i < OPS; i++) {
                        await collect(entityOps.createAll(HEAVY_MODEL, [{
                            email: `user${i}@example.com`,
                            status: statuses[i % 4],
                            priority: (i % 10) + 1,
                            amount: Math.random() * 10000,
                            name: `  Test User ${i}  `, // Will be trimmed
                            active: i % 2 === 0,
                            notes: `Some notes for record ${i}`,
                        }]));
                    }
                }
            );
            results.push(heavyResult);
        }

        console.log('\nLight vs Heavy Model (observer workload comparison):');
        formatTable(results);

        // Calculate overhead
        for (let i = 0; i < results.length; i += 2) {
            const light = results[i]!;
            const heavy = results[i + 1]!;
            const label = light.name.split(' ')[0];

            const overhead = ((heavy.totalMs - light.totalMs) / light.totalMs) * 100;
            const slowdown = heavy.totalMs / light.totalMs;

            console.log(`\n${label}:`);
            console.log(`  Light: ${light.opsPerSec.toFixed(0)} ops/sec`);
            console.log(`  Heavy: ${heavy.opsPerSec.toFixed(0)} ops/sec`);
            console.log(`  Overhead: +${overhead.toFixed(1)}% (${slowdown.toFixed(2)}x slower)`);
        }

        expect(results.length).toBe(4);
    }, TIMEOUT_LONG);

    it('should show full breakdown: passthrough vs light vs heavy', async () => {
        const OPS = 200;
        const results: BenchResult[] = [];

        for (const [label, stack] of [['SQLite', sqliteStack], ['PostgreSQL', pgStack]] as const) {
            const entityOps = stack.entityOps!;

            // Passthrough (no observer pipeline)
            const passthroughResult = await benchmark(
                `${label} Passthrough`,
                OPS,
                async () => {
                    for (let i = 0; i < OPS; i++) {
                        await collect(entityOps.createAll(PASSTHROUGH_MODEL, [{
                            name: `breakdown-pt-${i}`,
                            value: i,
                        }]));
                    }
                }
            );
            results.push(passthroughResult);

            // Light pipeline
            const lightResult = await benchmark(
                `${label} Light`,
                OPS,
                async () => {
                    for (let i = 0; i < OPS; i++) {
                        await collect(entityOps.createAll(NORMAL_MODEL, [{
                            name: `breakdown-light-${i}`,
                            value: i,
                        }]));
                    }
                }
            );
            results.push(lightResult);

            // Heavy pipeline
            const heavyResult = await benchmark(
                `${label} Heavy`,
                OPS,
                async () => {
                    const statuses = ['draft', 'pending', 'active', 'closed'];
                    for (let i = 0; i < OPS; i++) {
                        await collect(entityOps.createAll(HEAVY_MODEL, [{
                            email: `breakdown${i}@example.com`,
                            status: statuses[i % 4],
                            priority: (i % 10) + 1,
                            amount: Math.random() * 10000,
                            name: `  Test ${i}  `,
                            active: i % 2 === 0,
                        }]));
                    }
                }
            );
            results.push(heavyResult);
        }

        console.log('\nFull Breakdown (Passthrough → Light Pipeline → Heavy Pipeline):');
        formatTable(results);

        for (let i = 0; i < results.length; i += 3) {
            const passthrough = results[i]!;
            const light = results[i + 1]!;
            const heavy = results[i + 2]!;
            const label = passthrough.name.split(' ')[0];

            console.log(`\n${label} breakdown:`);
            console.log(`  Passthrough:     ${passthrough.opsPerSec.toFixed(0)} ops/sec (baseline)`);
            console.log(`  Light Pipeline:  ${light.opsPerSec.toFixed(0)} ops/sec (${(light.totalMs / passthrough.totalMs).toFixed(2)}x vs passthrough)`);
            console.log(`  Heavy Pipeline:  ${heavy.opsPerSec.toFixed(0)} ops/sec (${(heavy.totalMs / passthrough.totalMs).toFixed(2)}x vs passthrough)`);
            console.log(`  Heavy vs Light:  ${(heavy.totalMs / light.totalMs).toFixed(2)}x slower`);
        }

        expect(results.length).toBe(6);
    }, TIMEOUT_LONG);
});
