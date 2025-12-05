/**
 * Display Refresh Performance Tests
 *
 * Simulates display system workloads to answer:
 * "Is EMS fast enough for 60fps updates?" (~16.67ms per frame)
 *
 * RESULTS SUMMARY (on M3 Pro, SQLite in-memory)
 * ==============================================
 * | Scenario                    | Avg/Frame | FPS Achieved |
 * |-----------------------------|-----------|--------------|
 * | Single element update       |    51μs   |    ~20,000   |
 * | Batch 50 elements           |  2.25ms   |      ~440    |
 * | Batch 200 elements (reflow) |  8.18ms   |      ~122    |
 * | Query 200 elements          |   274μs   |     ~3,700   |
 * | Hit test (single lookup)    |    19μs   |    ~53,000   |
 * | Full frame (query+update)   |   794μs   |     ~1,300   |
 * | Interactive (CRUD cycle)    |   396μs   |     ~2,500   |
 * | 1000 elements (10% update)  |  6.97ms   |      ~143    |
 *
 * CONCLUSION: YES, EMS is fast enough for 60fps display updates.
 * The bottleneck for a display system will likely be:
 * - Network/WebSocket latency (not database)
 * - Browser DOM rendering (not EMS operations)
 * - JSON serialization overhead
 *
 * Tests simulate:
 * - Single element updates (cursor, animation)
 * - Batch element updates (scrolling, layout)
 * - Window/element hierarchy queries (render pass)
 * - Full frame simulation (read + update mixed workload)
 *
 * Uses the 'file' model to simulate display entities. In a real display system,
 * these would be separate models (display, window, element) with proper schemas.
 *
 * Run with: bun test ./perf/ems/display-refresh.perf.ts
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

const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgresql://localhost/monk_os';
const PG_SCHEMA = `display_perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** Target: 60fps = 16.67ms per frame */
const FRAME_BUDGET_MS = 1000 / 60;

/** Typical element counts for display scenarios */
const ELEMENT_COUNTS = {
    small: 50,      // Simple dialog
    medium: 200,    // Typical window
    large: 1000,    // Complex dashboard
};

// =============================================================================
// TYPES
// =============================================================================

interface BenchResult {
    scenario: string;
    backend: string;
    ops: number;
    totalMs: number;
    avgMs: number;
    opsPerSec: number;
    fps: number;
    meetsTarget: boolean;
}

interface FileEntity {
    id: string;
    model: string;
    parent: string | null;
    pathname: string;
    owner: string;
    data?: string;
    size?: number;
    created_at?: string;
    updated_at?: string;
    trashed_at?: string | null;
    expired_at?: string | null;
    [key: string]: unknown;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatTime(ms: number): string {
    if (ms < 0.001) return `${(ms * 1000000).toFixed(0)}ns`;
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function formatFps(fps: number): string {
    if (fps >= 1000) return `${(fps / 1000).toFixed(1)}k`;
    return fps.toFixed(0);
}

function printDisplayResults(title: string, results: BenchResult[]): void {
    console.log(`\n${title}:\n`);
    console.log('┌────────────────────────┬───────────┬──────────┬────────────┬──────────┬─────────┬────────┐');
    console.log('│ Scenario               │ Backend   │ Ops      │ Total      │ Avg/Op   │ FPS     │ 60fps? │');
    console.log('├────────────────────────┼───────────┼──────────┼────────────┼──────────┼─────────┼────────┤');
    for (const r of results) {
        const scenario = r.scenario.padEnd(22);
        const backend = r.backend.padEnd(9);
        const ops = r.ops.toString().padStart(8);
        const total = formatTime(r.totalMs).padStart(10);
        const avg = formatTime(r.avgMs).padStart(8);
        const fps = formatFps(r.fps).padStart(7);
        const meets = r.meetsTarget ? '  YES ' : '  no  ';
        console.log(`│ ${scenario} │ ${backend} │ ${ops} │ ${total} │ ${avg} │ ${fps} │${meets}│`);
    }
    console.log('└────────────────────────┴───────────┴──────────┴────────────┴──────────┴─────────┴────────┘');
    console.log(`\nTarget: ${FRAME_BUDGET_MS.toFixed(2)}ms per frame (60fps)\n`);
}

function calculateResult(
    scenario: string,
    backend: string,
    ops: number,
    totalMs: number
): BenchResult {
    const avgMs = totalMs / ops;
    const opsPerSec = (ops / totalMs) * 1000;
    const fps = 1000 / avgMs;
    return {
        scenario,
        backend,
        ops,
        totalMs,
        avgMs,
        opsPerSec,
        fps,
        meetsTarget: avgMs <= FRAME_BUDGET_MS,
    };
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
// FIXTURE CREATION
// =============================================================================

async function createWindow(
    stack: OsStack,
    displayId: string,
    index: number,
    owner: string
): Promise<FileEntity> {
    const windows = await collect(
        stack.ems!.ops.createAll<FileEntity>('file', [{
            pathname: `window-${displayId}-${index}`,
            owner,
            parent: null,
            data: JSON.stringify({ type: 'window', display_id: displayId, title: `Window ${index}` }),
        }])
    );
    return windows[0]!;
}

async function createElements(
    stack: OsStack,
    windowId: string,
    count: number,
    owner: string
): Promise<FileEntity[]> {
    const elements = Array.from({ length: count }, (_, i) => ({
        pathname: `elem-${windowId.slice(0, 8)}-${i}`,
        owner,
        parent: null,
        data: JSON.stringify({
            type: 'element',
            window_id: windowId,
            tag: i % 5 === 0 ? 'button' : i % 3 === 0 ? 'input' : 'div',
            props: { class: `elem-${i}`, style: { top: i * 20, left: 10 } },
            text: i % 2 === 0 ? `Text ${i}` : null,
            order: i,
        }),
    }));

    return collect(stack.ems!.ops.createAll<FileEntity>('file', elements));
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Display Refresh: Single Element Updates', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;
    let sqliteWindow: FileEntity;
    let pgWindow: FileEntity;
    let sqliteElements: FileEntity[];
    let pgElements: FileEntity[];

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_single`);

        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('single');

        const owner = 'display-perf';
        sqliteWindow = await createWindow(sqlite, 'display-0', 0, owner);
        pgWindow = await createWindow(postgres, 'display-0', 0, owner);

        sqliteElements = await createElements(sqlite, sqliteWindow.id, ELEMENT_COUNTS.medium, owner);
        pgElements = await createElements(postgres, pgWindow.id, ELEMENT_COUNTS.medium, owner);
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_single CASCADE`);
        adminSql.close();
    });

    it('cursor position update (1000 single-element updates)', async () => {
        const iterations = 1000;
        const results: BenchResult[] = [];

        // SQLite
        const sqliteStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const elemIndex = i % sqliteElements.length;
            await collect(
                sqlite.ems!.ops.updateAll<FileEntity>('file', [{
                    id: sqliteElements[elemIndex]!.id,
                    changes: {
                        data: JSON.stringify({
                            type: 'element',
                            props: { class: `elem-${elemIndex}`, style: { top: 100 + i, left: 100 + i } },
                        }),
                    },
                }])
            );
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult('cursor update', 'SQLite', iterations, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const elemIndex = i % pgElements.length;
            await collect(
                postgres.ems!.ops.updateAll<FileEntity>('file', [{
                    id: pgElements[elemIndex]!.id,
                    changes: {
                        data: JSON.stringify({
                            type: 'element',
                            props: { class: `elem-${elemIndex}`, style: { top: 100 + i, left: 100 + i } },
                        }),
                    },
                }])
            );
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult('cursor update', 'PostgreSQL', iterations, pgMs));

        printDisplayResults('Single Element Position Update', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });

    it('text content update (500 single-element updates)', async () => {
        const iterations = 500;
        const results: BenchResult[] = [];

        // SQLite
        const sqliteStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const elemIndex = i % sqliteElements.length;
            await collect(
                sqlite.ems!.ops.updateAll<FileEntity>('file', [{
                    id: sqliteElements[elemIndex]!.id,
                    changes: {
                        data: JSON.stringify({ type: 'element', text: `Updated text ${i}` }),
                    },
                }])
            );
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult('text update', 'SQLite', iterations, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const elemIndex = i % pgElements.length;
            await collect(
                postgres.ems!.ops.updateAll<FileEntity>('file', [{
                    id: pgElements[elemIndex]!.id,
                    changes: {
                        data: JSON.stringify({ type: 'element', text: `Updated text ${i}` }),
                    },
                }])
            );
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult('text update', 'PostgreSQL', iterations, pgMs));

        printDisplayResults('Single Element Text Update', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('Display Refresh: Batch Element Updates', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;
    let sqliteWindow: FileEntity;
    let pgWindow: FileEntity;
    let sqliteElements: FileEntity[];
    let pgElements: FileEntity[];

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_batch`);

        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('batch');

        const owner = 'display-batch';
        sqliteWindow = await createWindow(sqlite, 'display-0', 0, owner);
        pgWindow = await createWindow(postgres, 'display-0', 0, owner);

        sqliteElements = await createElements(sqlite, sqliteWindow.id, ELEMENT_COUNTS.medium, owner);
        pgElements = await createElements(postgres, pgWindow.id, ELEMENT_COUNTS.medium, owner);
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_batch CASCADE`);
        adminSql.close();
    });

    it('scroll simulation: batch update 50 elements x 100 frames', async () => {
        const frames = 100;
        const batchSize = 50;
        const results: BenchResult[] = [];

        // SQLite
        const sqliteStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const updates = sqliteElements.slice(0, batchSize).map((elem, i) => ({
                id: elem.id,
                changes: {
                    data: JSON.stringify({
                        type: 'element',
                        props: { class: `elem-${i}`, style: { top: i * 20 - frame * 10, left: 10 } },
                    }),
                },
            }));
            await collect(sqlite.ems!.ops.updateAll<FileEntity>('file', updates));
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult(`batch(${batchSize}) scroll`, 'SQLite', frames, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const updates = pgElements.slice(0, batchSize).map((elem, i) => ({
                id: elem.id,
                changes: {
                    data: JSON.stringify({
                        type: 'element',
                        props: { class: `elem-${i}`, style: { top: i * 20 - frame * 10, left: 10 } },
                    }),
                },
            }));
            await collect(postgres.ems!.ops.updateAll<FileEntity>('file', updates));
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult(`batch(${batchSize}) scroll`, 'PostgreSQL', frames, pgMs));

        printDisplayResults('Batch Scroll Simulation (50 elements/frame)', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });

    it('layout reflow: batch update all 200 elements x 30 frames', async () => {
        const frames = 30;
        const results: BenchResult[] = [];

        // SQLite
        const sqliteStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const updates = sqliteElements.map((elem, i) => ({
                id: elem.id,
                changes: {
                    data: JSON.stringify({
                        type: 'element',
                        props: { class: `elem-${i}`, style: { top: i * (20 + frame % 5), left: 10 + frame % 10 } },
                    }),
                },
            }));
            await collect(sqlite.ems!.ops.updateAll<FileEntity>('file', updates));
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult(`batch(${sqliteElements.length}) reflow`, 'SQLite', frames, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const updates = pgElements.map((elem, i) => ({
                id: elem.id,
                changes: {
                    data: JSON.stringify({
                        type: 'element',
                        props: { class: `elem-${i}`, style: { top: i * (20 + frame % 5), left: 10 + frame % 10 } },
                    }),
                },
            }));
            await collect(postgres.ems!.ops.updateAll<FileEntity>('file', updates));
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult(`batch(${pgElements.length}) reflow`, 'PostgreSQL', frames, pgMs));

        printDisplayResults('Batch Layout Reflow (200 elements/frame)', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });
});

describe('Display Refresh: Element Queries (Render Pass)', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;
    let sqliteWindow: FileEntity;
    let pgWindow: FileEntity;
    let sqliteElements: FileEntity[];
    let pgElements: FileEntity[];

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_query`);

        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('query');

        const owner = 'display-query';
        sqliteWindow = await createWindow(sqlite, 'display-0', 0, owner);
        pgWindow = await createWindow(postgres, 'display-0', 0, owner);

        sqliteElements = await createElements(sqlite, sqliteWindow.id, ELEMENT_COUNTS.medium, owner);
        pgElements = await createElements(postgres, pgWindow.id, ELEMENT_COUNTS.medium, owner);
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_query CASCADE`);
        adminSql.close();
    });

    it('query all elements by owner (render pass) x 200 frames', async () => {
        const frames = 200;
        const results: BenchResult[] = [];

        // SQLite
        const sqliteStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const elements = await collect(
                sqlite.ems!.ops.selectAny<FileEntity>('file', {
                    where: { owner: 'display-query' },
                })
            );
            // Window + elements
            expect(elements.length).toBe(ELEMENT_COUNTS.medium + 1);
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult('query 200 elements', 'SQLite', frames, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const elements = await collect(
                postgres.ems!.ops.selectAny<FileEntity>('file', {
                    where: { owner: 'display-query' },
                })
            );
            expect(elements.length).toBe(ELEMENT_COUNTS.medium + 1);
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult('query 200 elements', 'PostgreSQL', frames, pgMs));

        printDisplayResults('Render Pass: Query All Window Elements', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_MEDIUM });

    it('query single element by id (hit testing) x 1000', async () => {
        const iterations = 1000;
        const results: BenchResult[] = [];

        // SQLite
        const sqliteStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const elemId = sqliteElements[i % sqliteElements.length]!.id;
            await collect(sqlite.ems!.ops.selectIds<FileEntity>('file', [elemId]));
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult('hit test lookup', 'SQLite', iterations, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            const elemId = pgElements[i % pgElements.length]!.id;
            await collect(postgres.ems!.ops.selectIds<FileEntity>('file', [elemId]));
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult('hit test lookup', 'PostgreSQL', iterations, pgMs));

        printDisplayResults('Hit Testing: Single Element Lookup', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_MEDIUM });
});

describe('Display Refresh: Full Frame Simulation', () => {
    let sqlite: OsStack;
    let postgres: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;
    let sqliteWindow: FileEntity;
    let pgWindow: FileEntity;
    let sqliteElements: FileEntity[];
    let pgElements: FileEntity[];

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}_frame`);

        sqlite = await createSqliteStack();
        postgres = await createPostgresStack('frame');

        const owner = 'display-frame';
        sqliteWindow = await createWindow(sqlite, 'display-0', 0, owner);
        pgWindow = await createWindow(postgres, 'display-0', 0, owner);

        sqliteElements = await createElements(sqlite, sqliteWindow.id, ELEMENT_COUNTS.medium, owner);
        pgElements = await createElements(postgres, pgWindow.id, ELEMENT_COUNTS.medium, owner);
    });

    afterAll(async () => {
        await sqlite.shutdown();
        await postgres.shutdown();
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA}_frame CASCADE`);
        adminSql.close();
    });

    it('full frame: query + update 10 elements x 100 frames', async () => {
        const frames = 100;
        const updateCount = 10;
        const results: BenchResult[] = [];

        // SQLite
        const sqliteStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            // 1. Query all elements (render state)
            const elements = await collect(
                sqlite.ems!.ops.selectAny<FileEntity>('file', {
                    where: { owner: 'display-frame' },
                })
            );

            // 2. Update subset (user interaction, animation)
            const updates = elements.slice(0, updateCount).map((elem, i) => ({
                id: elem.id,
                changes: {
                    data: JSON.stringify({
                        type: 'element',
                        props: { class: `elem-${i}`, style: { top: i * 20, left: frame % 100 } },
                    }),
                },
            }));
            await collect(sqlite.ems!.ops.updateAll<FileEntity>('file', updates));
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult(`frame(q+u${updateCount})`, 'SQLite', frames, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const elements = await collect(
                postgres.ems!.ops.selectAny<FileEntity>('file', {
                    where: { owner: 'display-frame' },
                })
            );

            const updates = elements.slice(0, updateCount).map((elem, i) => ({
                id: elem.id,
                changes: {
                    data: JSON.stringify({
                        type: 'element',
                        props: { class: `elem-${i}`, style: { top: i * 20, left: frame % 100 } },
                    }),
                },
            }));
            await collect(postgres.ems!.ops.updateAll<FileEntity>('file', updates));
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult(`frame(q+u${updateCount})`, 'PostgreSQL', frames, pgMs));

        printDisplayResults('Full Frame: Query + Update 10 Elements', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });

    it('interactive frame: query + create + update + delete x 50 frames', async () => {
        const frames = 50;
        const results: BenchResult[] = [];
        const owner = 'display-interactive';

        // SQLite
        const sqliteStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            // 1. Query window elements
            const elements = await collect(
                sqlite.ems!.ops.selectAny<FileEntity>('file', {
                    where: { owner: 'display-frame' },
                })
            );

            // 2. Create new element (dynamic content)
            const newElems = await collect(
                sqlite.ems!.ops.createAll<FileEntity>('file', [{
                    pathname: `dynamic-sqlite-${frame}`,
                    owner,
                    parent: null,
                    data: JSON.stringify({ type: 'element', text: `Frame ${frame}` }),
                }])
            );

            // 3. Update existing element
            if (elements.length > 0) {
                await collect(
                    sqlite.ems!.ops.updateAll<FileEntity>('file', [{
                        id: elements[frame % elements.length]!.id,
                        changes: {
                            data: JSON.stringify({ type: 'element', text: `Updated at frame ${frame}` }),
                        },
                    }])
                );
            }

            // 4. Delete the dynamic element (cleanup)
            await collect(sqlite.ems!.ops.deleteIds('file', [newElems[0]!.id]));
        }
        const sqliteMs = performance.now() - sqliteStart;
        results.push(calculateResult('interactive frame', 'SQLite', frames, sqliteMs));

        // PostgreSQL
        const pgStart = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            const elements = await collect(
                postgres.ems!.ops.selectAny<FileEntity>('file', {
                    where: { owner: 'display-frame' },
                })
            );

            const newElems = await collect(
                postgres.ems!.ops.createAll<FileEntity>('file', [{
                    pathname: `dynamic-pg-${frame}`,
                    owner,
                    parent: null,
                    data: JSON.stringify({ type: 'element', text: `Frame ${frame}` }),
                }])
            );

            if (elements.length > 0) {
                await collect(
                    postgres.ems!.ops.updateAll<FileEntity>('file', [{
                        id: elements[frame % elements.length]!.id,
                        changes: {
                            data: JSON.stringify({ type: 'element', text: `Updated at frame ${frame}` }),
                        },
                    }])
                );
            }

            await collect(postgres.ems!.ops.deleteIds('file', [newElems[0]!.id]));
        }
        const pgMs = performance.now() - pgStart;
        results.push(calculateResult('interactive frame', 'PostgreSQL', frames, pgMs));

        printDisplayResults('Interactive Frame: Query + Create + Update + Delete', results);
        expect(results[0]!.totalMs).toBeLessThan(60000);
    }, { timeout: TIMEOUT_LONG });
});

describe('Display Refresh: Scalability', () => {
    let sqlite: OsStack;
    let adminSql: InstanceType<typeof Bun.SQL>;

    beforeAll(async () => {
        adminSql = new Bun.SQL(POSTGRES_URL);
        sqlite = await createSqliteStack();
    });

    afterAll(async () => {
        await sqlite.shutdown();
        adminSql.close();
    });

    it('element count scaling: 50, 200, 1000 elements (SQLite)', async () => {
        const results: BenchResult[] = [];
        const frames = 60; // 1 second at 60fps
        const baseOwner = 'scale-test';

        for (const count of [ELEMENT_COUNTS.small, ELEMENT_COUNTS.medium, ELEMENT_COUNTS.large]) {
            const owner = `${baseOwner}-${count}`;

            // Create window and elements
            const window = await createWindow(sqlite, `display-${count}`, count, owner);
            const elements = await createElements(sqlite, window.id, count, owner);

            // Time: query + update 10% of elements per frame
            const updateCount = Math.max(1, Math.floor(count * 0.1));
            const start = performance.now();

            for (let frame = 0; frame < frames; frame++) {
                await collect(
                    sqlite.ems!.ops.selectAny<FileEntity>('file', {
                        where: { owner },
                    })
                );

                const updates = elements.slice(0, updateCount).map((elem, i) => ({
                    id: elem.id,
                    changes: {
                        data: JSON.stringify({
                            type: 'element',
                            props: { style: { top: i * 20, left: frame } },
                        }),
                    },
                }));
                await collect(sqlite.ems!.ops.updateAll<FileEntity>('file', updates));
            }

            const totalMs = performance.now() - start;
            results.push(calculateResult(`${count} elements`, 'SQLite', frames, totalMs));

            // Cleanup
            await collect(sqlite.ems!.ops.deleteIds('file', elements.map(e => e.id)));
            await collect(sqlite.ems!.ops.deleteIds('file', [window.id]));
        }

        printDisplayResults('Element Count Scaling (60 frames, 10% updates/frame)', results);
        expect(results.length).toBe(3);
    }, { timeout: TIMEOUT_LONG });
});
