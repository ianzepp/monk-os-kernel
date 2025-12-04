# OS Transactions: Atomic Multi-Statement Database Operations

## Implementation Status: COMPLETED

| Phase | Description | Status |
|-------|-------------|--------|
| 1.1 | Add transaction types to `channel/types.ts` | Done |
| 1.2 | Add transaction op to SQLite channel | Done |
| 1.3 | Add transaction op to PostgreSQL channel | Done |
| 2 | Add `transaction()` to DatabaseConnection | Done |
| 3 | Update SqlCreate to use `transaction()` | Done |
| 4 | Run tests and verify parallel creates | Done |

**Results:**
- All 475 EMS tests pass
- Parallel CREATE: ~25k ops/sec at 100 concurrency (both backends)
- Parallel UPDATE: ~24k ops/sec at 100 concurrency
- Parallel SELECT: ~60k ops/sec at 200 concurrency
- High concurrency burst (200 simultaneous): ~24k ops/sec

The "cannot start transaction within transaction" error is resolved.

---

## Problem Statement

The EMS (Entity Model System) currently executes transactions as multiple separate database calls:

```typescript
await system.db.execute('BEGIN IMMEDIATE');
await system.db.execute('INSERT INTO entities...');
await system.db.execute('INSERT INTO file...');
await system.db.execute('COMMIT');
```

This breaks under parallel execution because:
1. Each `execute()` is a separate message to the HAL channel
2. Parallel creates interleave: `A:BEGIN → B:BEGIN → ERROR`
3. The transaction boundary spans multiple async calls, allowing event loop yields between them

Both SQLite and PostgreSQL fail with "cannot start a transaction within a transaction" when parallel creates race.

## Solution

Send the entire transaction as a **single message** to the HAL channel. The channel executes it atomically using Bun's `sql.begin()` API.

```typescript
await system.db.transaction([
    { sql: 'INSERT INTO entities...', params: [...] },
    { sql: 'INSERT INTO file...', params: [...] },
]);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  EMS Layer (Ring 5 Observers)                               │
│  SqlCreate, SqlUpdate, SqlDelete                            │
│                                                             │
│  await system.db.transaction([...statements])               │
├─────────────────────────────────────────────────────────────┤
│  DatabaseConnection (src/ems/connection.ts)                 │
│                                                             │
│  async transaction(statements): Promise<TransactionResult>  │
│  → channel.handle({ op: 'transaction', data: {statements}}) │
├─────────────────────────────────────────────────────────────┤
│  HAL Channel Interface                                      │
│                                                             │
│  case 'transaction':                                        │
│    → Bun's sql.begin(async tx => { ... })                   │
├─────────────────────────────────────────────────────────────┤
│  Bun Runtime                                                │
│  bun:sqlite / Bun.SQL                                       │
│  Handles locking, atomicity, rollback                       │
└─────────────────────────────────────────────────────────────┘
```

## API Design

### Message Format

```typescript
interface TransactionMessage {
    op: 'transaction';
    data: {
        statements: Array<{
            sql: string;
            params?: unknown[];
        }>;
    };
}
```

### Response Format

```typescript
// Success
{ op: 'ok', data: { results: number[] } }  // affected rows per statement

// Failure (entire transaction rolled back)
{ op: 'error', data: { code: string, message: string } }
```

### DatabaseConnection API

```typescript
class DatabaseConnection {
    /**
     * Execute multiple statements in a single atomic transaction.
     * All statements succeed or all are rolled back.
     *
     * @param statements - Array of SQL statements with optional params
     * @returns Array of affected row counts (one per statement)
     * @throws EIO on transaction failure (already rolled back)
     */
    async transaction(
        statements: Array<{ sql: string; params?: unknown[] }>
    ): Promise<number[]>;
}
```

## Implementation Plan

### Phase 1: HAL Layer

#### 1.1 Update Channel Types (`src/hal/channel/types.ts`)

Add transaction-specific types:

```typescript
export interface TransactionStatement {
    sql: string;
    params?: unknown[];
}

export interface TransactionData {
    statements: TransactionStatement[];
}

export interface TransactionResult {
    results: number[];
}
```

#### 1.2 Update SQLite Channel (`src/hal/channel/sqlite.ts`)

Add `transaction` case to `handle()`:

```typescript
case 'transaction': {
    const { statements } = msg.data as TransactionData;
    const results: number[] = [];

    this.db.transaction(() => {
        for (const stmt of statements) {
            const prepared = this.db.prepare(stmt.sql);
            const result = prepared.run(...(stmt.params ?? []));
            results.push(result.changes);
        }
    })();

    yield respond.ok({ results });
    break;
}
```

Note: `bun:sqlite` uses `db.transaction(callback)()` - returns a function that must be called.

#### 1.3 Update PostgreSQL Channel (`src/hal/channel/postgres.ts`)

Add `transaction` case to `handle()`:

```typescript
case 'transaction': {
    const { statements } = msg.data as TransactionData;
    const results: number[] = [];

    await this.sql.begin(async (tx) => {
        for (const stmt of statements) {
            const result = await tx.unsafe(stmt.sql, stmt.params ?? []);
            results.push(result.count);
        }
    });

    yield respond.ok({ results });
    break;
}
```

### Phase 2: EMS Layer

#### 2.1 Update DatabaseConnection (`src/ems/connection.ts`)

Add `transaction()` method:

```typescript
async transaction(
    statements: Array<{ sql: string; params?: unknown[] }>
): Promise<number[]> {
    for await (const response of this.channel.handle({
        op: 'transaction',
        data: { statements },
    })) {
        switch (response.op) {
            case 'ok': {
                const data = response.data as { results: number[] };
                return data.results;
            }
            case 'error': {
                const err = response.data as { code: string; message: string };
                throw new EIO(`Transaction failed [${err.code}]: ${err.message}`);
            }
        }
    }
    throw new EIO('Transaction returned no response');
}
```

### Phase 3: Ring 5 Observers

#### 3.1 Update SqlCreate (`src/ems/ring/5/50-sql-create.ts`)

Replace manual BEGIN/COMMIT with transaction():

```typescript
async execute(context: ObserverContext): Promise<void> {
    const { model, record, system } = context;
    const data = record.toRecord();

    // Meta-models don't use entities table
    if (META_MODELS.has(model.modelName)) {
        await this.insertDirect(system.db, model.modelName, data);
        return;
    }

    // Entity models: atomic transaction for entities + detail
    try {
        await system.db.transaction([
            {
                sql: 'INSERT INTO entities (id, model, parent, pathname) VALUES (?, ?, ?, ?)',
                params: [data.id, model.modelName, data.parent ?? null, data.pathname ?? ''],
            },
            {
                sql: this.buildDetailInsert(model.modelName, data),
                params: this.buildDetailParams(data),
            },
        ]);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new EOBSSYS(`INSERT failed for ${model.modelName}[${data.id}]: ${message}`);
    }
}
```

#### 3.2 Review SqlUpdate and SqlDelete

Check if these observers use transactions. If so, update them similarly.

- `src/ems/ring/5/50-sql-update.ts`
- `src/ems/ring/5/50-sql-delete.ts`

### Phase 4: Testing

#### 4.1 Unit Tests

- `spec/hal/channel/sqlite.test.ts` - Add transaction op tests
- `spec/hal/channel/postgres.test.ts` - Add transaction op tests
- `spec/ems/connection.test.ts` - Add transaction() method tests

#### 4.2 Integration Tests

- `spec/ems/entity-ops.test.ts` - Verify creates still work

#### 4.3 Performance Tests

- Update `perf/ems/entity-parallel.perf.ts` - Parallel creates should now work

## Rollback Strategy

If a transaction fails:
- HAL layer catches the error
- Bun's `sql.begin()` automatically rolls back
- HAL yields `respond.error()` with the failure reason
- DatabaseConnection throws `EIO`
- Ring 5 observer catches and wraps in `EOBSSYS`
- Observer pipeline handles error per ring semantics

No partial writes occur - the transaction is all-or-nothing.

## Migration Notes

### Backward Compatibility

The existing `execute()` method remains unchanged. Code that doesn't need transactions continues to work. Only Ring 5 observers that currently use manual BEGIN/COMMIT need updating.

### Meta-Models

Meta-models (models, fields, tracked) don't use transactions because they only insert into a single table. No change needed for these.

## Success Criteria

1. `perf/ems/entity-parallel.perf.ts` - Parallel CREATE tests pass for both SQLite and PostgreSQL
2. All existing EMS tests continue to pass
3. No regression in serial operation performance

## Future Considerations

### Nested Transactions / Savepoints

Bun's API supports savepoints:

```typescript
await sql.begin(async tx => {
    await tx`INSERT ...`;
    await tx.savepoint(async sp => {
        await sp`UPDATE ...`;
        // Can rollback to savepoint without aborting outer transaction
    });
});
```

If needed, the transaction message format could be extended:

```typescript
{
    op: 'transaction',
    data: {
        statements: [...],
        savepoints: [{ name: 'sp1', statements: [...] }]
    }
}
```

Not implementing now - wait for concrete use case.

### Read-Only Transactions

PostgreSQL supports `BEGIN READ ONLY` for snapshot isolation. Could add:

```typescript
{
    op: 'transaction',
    data: {
        mode: 'readonly',  // or 'readwrite' (default)
        statements: [...]
    }
}
```

Not implementing now - current use cases are all write transactions.

## References

- [Bun SQL Documentation](https://bun.com/docs/runtime/sql)
- [bun:sqlite transaction API](https://bun.sh/docs/api/sqlite#transactions)
- `docs/bugs/EMS_PARALLEL_WRITES.md` - Original bug documentation
- `perf/ems/entity-parallel.perf.ts` - Parallel performance tests
