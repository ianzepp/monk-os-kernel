# Performance Testing Guide

Write performance and load tests for Monk OS subsystems.

---

## Overview

Performance tests live in `perf/` and run via `bun run perf`. They validate:

1. **Throughput** - Operations per second under load
2. **Correctness under stress** - No data corruption at volume
3. **Backend comparison** - SQLite vs PostgreSQL vs Memory
4. **Regression detection** - Catch performance degradation early

---

## Directory Structure

```
perf/
├── bun-perf-setup.ts      # Shared helpers (generateMessages, drainPipe, etc.)
├── fixtures.ts            # Generate test fixtures
├── ems/                   # Entity Model System tests
│   ├── entity-compare.perf.ts
│   └── passthrough-compare.perf.ts
├── kernel/                # Process, syscall, pipe tests
│   └── process-spawn.perf.ts
├── hal/                   # Hardware abstraction tests
└── vfs/                   # Virtual filesystem tests
```

---

## File Naming

```
{subsystem}/{feature}-{type}.perf.ts
```

| Type | Purpose |
|------|---------|
| `compare` | Compare backends (SQLite vs PostgreSQL) |
| `stress` | High-volume correctness validation |
| `bench` | Pure throughput measurement |
| `cycle` | Repeated setup/teardown |

Examples:
- `ems/entity-compare.perf.ts` - Compare entity ops across backends
- `kernel/process-spawn.perf.ts` - Process lifecycle stress test
- `hal/storage-bench.perf.ts` - Raw storage throughput

---

## Test Structure Template

```typescript
/**
 * [Subsystem] [Feature] Performance Tests
 *
 * [One paragraph: what this tests and why it matters]
 *
 * Run with: bun test ./perf/subsystem/feature.perf.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
// ... imports

// =============================================================================
// CONFIGURATION
// =============================================================================

const TIMEOUT_MEDIUM = 60_000;   // 1 minute
const TIMEOUT_LONG = 120_000;    // 2 minutes

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
    ops: number,
    fn: (i: number) => Promise<T>
): Promise<BenchResult> {
    const start = performance.now();
    for (let i = 0; i < ops; i++) {
        await fn(i);
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

describe('Feature: Single Operations', () => {
    // Setup/teardown here

    it('should complete N operations', async () => {
        // Test implementation
    }, { timeout: TIMEOUT_MEDIUM });
});
```

---

## Isolation Patterns

### Unique Identifiers

Always use unique identifiers to prevent test pollution:

```typescript
// Unique owner per test
const owner = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Unique schema for PostgreSQL
const PG_SCHEMA = `perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

### PostgreSQL Schema Isolation

```typescript
let adminSql: InstanceType<typeof Bun.SQL>;

beforeAll(async () => {
    adminSql = new Bun.SQL(POSTGRES_URL);
    await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);

    // Create stack with schema
    postgres = await createOsStack({
        hal: {
            storage: {
                type: 'postgres',
                url: `${POSTGRES_URL}?options=-c%20search_path%3D${PG_SCHEMA}`
            }
        },
        ems: true,
    });
});

afterAll(async () => {
    await postgres.shutdown();
    await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    adminSql.close();
});
```

---

## Test Categories

### 1. Single Operation Tests

Test individual operations in isolation:

```typescript
it('CREATE: 500 files (single ops)', async () => {
    const count = 500;
    const result = await runBench('SQLite', count, async (i) => {
        await createFile(`file-${i}.txt`);
    });

    console.log('\nCREATE 500 files:');
    printResults([result]);
    expect(result.totalMs).toBeLessThan(30000);
}, { timeout: TIMEOUT_LONG });
```

### 2. Batch Operation Tests

Test bulk APIs:

```typescript
it('BATCH CREATE: 1000 files in single batch', async () => {
    const count = 1000;

    const start = performance.now();
    const files = await createFileBatch(count);
    const totalMs = performance.now() - start;

    expect(files).toHaveLength(count);
    console.log(`\nBatch created ${count} files in ${formatTime(totalMs)}`);
});
```

### 3. Backend Comparison Tests

Compare performance across storage backends:

```typescript
it('COMPARE: SQLite vs PostgreSQL', async () => {
    const count = 500;

    const sqliteResult = await runBench('SQLite', count, async (i) => {
        await sqliteStack.ems.createFile(`file-${i}.txt`);
    });

    const pgResult = await runBench('PostgreSQL', count, async (i) => {
        await pgStack.ems.createFile(`file-${i}.txt`);
    });

    console.log('\nBackend Comparison:');
    printResults([sqliteResult, pgResult]);
});
```

### 4. Mixed Workload Tests

Simulate realistic usage patterns:

```typescript
it('Read-heavy: 95% reads, 5% writes', async () => {
    const totalOps = 500;

    for (let i = 0; i < totalOps; i++) {
        if (Math.random() < 0.95) {
            await readRandomFile();
        }
        else {
            await createFile(`new-${i}.txt`);
        }
    }
});
```

### 5. Lifecycle Tests

Test setup/teardown under load:

```typescript
it('should complete 50 boot/shutdown cycles', async () => {
    let successCount = 0;

    for (let i = 0; i < 50; i++) {
        const hal = createTestHAL();
        const kernel = new Kernel(hal);

        await kernel.boot({ initPath: '/bin/true.ts' });
        await waitForExit(kernel);
        await kernel.shutdown();
        await hal.shutdown();

        successCount++;
    }

    expect(successCount).toBe(50);
}, { timeout: TIMEOUT_LONG });
```

### 6. Stress Tests

Validate correctness under extreme conditions:

```typescript
it('should pipe 1000 char string through 5 cats', async () => {
    const text = 'x'.repeat(1000);

    await kernel.boot({
        initPath: '/bin/shell.ts',
        initArgs: ['shell', '-c', `echo ${text} | cat | cat | cat | cat | cat`],
    });

    const exited = await waitForInitExit(kernel, 30000);
    expect(exited).toBe(true);

    const output = hal.console.getOutput();
    expect(output.trim()).toBe(text);
}, { timeout: TIMEOUT_LONG });
```

---

## Output Formatting

### ASCII Tables

Use consistent table formatting for results:

```
┌─────────────────────┬──────────┬────────────┬──────────┬────────────┐
│ Backend             │ Ops      │ Total      │ Avg/Op   │ Throughput │
├─────────────────────┼──────────┼────────────┼──────────┼────────────┤
│ SQLite              │      500 │     1.23s  │   2.46ms │   406 ops/sec │
│ PostgreSQL          │      500 │     3.45s  │   6.90ms │   145 ops/sec │
└─────────────────────┴──────────┴────────────┴──────────┴────────────┘
```

### Time Formatting

```typescript
function formatTime(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}
```

---

## Timeouts

Set appropriate timeouts for long-running tests:

```typescript
const TIMEOUT_SHORT = 10_000;    // 10 seconds
const TIMEOUT_MEDIUM = 60_000;   // 1 minute
const TIMEOUT_LONG = 120_000;    // 2 minutes

it('quick test', async () => { ... });  // Default 5s

it('medium test', async () => { ... }, { timeout: TIMEOUT_MEDIUM });

it('long test', async () => { ... }, { timeout: TIMEOUT_LONG });
```

---

## Shared Helpers

Use `perf/bun-perf-setup.ts` for common utilities:

```typescript
import {
    generateMessages,      // Generator for N test messages
    generateLargePayload,  // Create binary payload of N bytes
    generateTextPayload,   // Create text payload of N chars
    drainPipe,             // Collect all messages from pipe
    sendAll,               // Send iterable to pipe
    verifyIntegrity,       // Check sent == received
    readFixture,           // Load pre-generated test data
    writeFixture,          // Save test data for reuse
} from '../bun-perf-setup';
```

---

## When to Write Performance Tests

| Scenario | Test Type |
|----------|-----------|
| New syscall | Single op + batch throughput |
| New storage backend | Compare with existing backends |
| Process lifecycle change | Boot/shutdown cycles |
| IPC change (pipes, channels) | Stress test with volume |
| VFS model addition | CRUD throughput + hierarchy |
| Observer pipeline change | Full pipeline vs passthrough |

---

## Checklist

Before submitting a perf test:

- [ ] File named `{feature}-{type}.perf.ts`
- [ ] Doc comment explaining what's tested and why
- [ ] Unique identifiers for test isolation
- [ ] PostgreSQL schema cleanup in afterAll
- [ ] Appropriate timeouts set
- [ ] Results printed with ASCII tables
- [ ] Assertions verify correctness, not just speed
- [ ] No hardcoded file paths (use owners, schemas)
- [ ] Run with `bun run perf` to verify

---

## Running Tests

```bash
# Run all perf tests
bun run perf

# Run specific test file
bun test ./perf/ems/entity-compare.perf.ts

# Run with coverage
bun run perf:coverage

# Generate fixtures first (if needed)
bun run perf:fixtures
```

---

## Example: Adding VFS Performance Tests

If adding a new VFS model, create `perf/vfs/new-model.perf.ts`:

```typescript
/**
 * VFS NewModel Performance Tests
 *
 * Measures throughput for the new model type across storage backends.
 *
 * Run with: bun test ./perf/vfs/new-model.perf.ts
 */

describe('VFS NewModel: CRUD Operations', () => {
    // Compare SQLite vs PostgreSQL
    // Test single ops, batch ops, queries by parent
});

describe('VFS NewModel: Hierarchical Operations', () => {
    // Nested structures
    // Deep trees
});

describe('VFS NewModel: Mixed Workload', () => {
    // Read-heavy, write-heavy, CRUD cycles
});
```

---

## Performance Baselines

When establishing baselines, document expected ranges:

```typescript
// BASELINE: SQLite should achieve >300 ops/sec for single creates
expect(sqliteResult.opsPerSec).toBeGreaterThan(300);

// BASELINE: PostgreSQL should be within 3x of SQLite
expect(pgResult.opsPerSec).toBeGreaterThan(sqliteResult.opsPerSec / 3);
```

Update baselines when hardware or architecture changes.
