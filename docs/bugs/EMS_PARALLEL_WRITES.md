# Bug: EMS Parallel Writes Fail Due to Single Connection

## Summary
The EMS (Entity Model System) uses a single database connection per stack. When multiple parallel operations attempt to create entities simultaneously, they fail with "cannot start a transaction within a transaction" because each CREATE operation wraps in a transaction.

This affects **both SQLite and PostgreSQL** backends identically.

## Working Cases
1. **Parallel SELECT by id** - ~53-60K ops/sec at any concurrency
2. **Parallel SELECT by query** - ~13-14K ops/sec at any concurrency
3. **Parallel UPDATE** - ~20-26K ops/sec at any concurrency (different rows)
4. **Serial CREATE** - ~16-22K ops/sec (one at a time)
5. **Mixed 90/10 read/write at concurrency 10** - ~49-51K ops/sec (low write frequency avoids conflicts)

## Broken Cases
1. **Parallel CREATE** - Fails at any concurrency level
2. **Mixed 50/50 read/write** - Fails at any concurrency level
3. **Mixed 90/10 read/write at concurrency 50+** - Fails (writes collide)
4. **High concurrency burst (200 simultaneous creates)** - Fails

## Error Message
```
EOBSSYS: INSERT failed for file[...]: Execute failed [EIO]: cannot start a transaction within a transaction
```

## Root Cause
The EMS observer pipeline wraps each CREATE operation in a transaction (BEGIN/COMMIT). When multiple async operations run in parallel on the same connection:

```
Operation 1: BEGIN → INSERT → ... (not yet committed)
Operation 2: BEGIN → ERROR: cannot start transaction within transaction
```

This is a fundamental limitation of using a single database connection.

## Debug Output

### Serial Creates (Works)
```typescript
await collect(entityOps.createAll('file', [{ pathname: 'a.txt', ... }]));
await collect(entityOps.createAll('file', [{ pathname: 'b.txt', ... }]));
// Each completes before next starts - no conflict
```

### Parallel Creates (Fails)
```typescript
await Promise.all([
    collect(entityOps.createAll('file', [{ pathname: 'a.txt', ... }])),
    collect(entityOps.createAll('file', [{ pathname: 'b.txt', ... }])),
]);
// Both try to BEGIN simultaneously - conflict
```

## Affected Code

### Transaction wrapper (src/ems/ring/5/50-sql-create.ts)
```typescript
await system.db.execute('BEGIN');
try {
    // INSERT operations
    await system.db.execute('COMMIT');
} catch (err) {
    await system.db.execute('ROLLBACK');
    throw err;
}
```

### Single connection per stack (src/os/stack.ts)
```typescript
db = await createDatabase(hal.channel, hal.file);  // One connection
entityOps = new EntityOps(db, modelCache, observerRunner);  // Shared
```

## Potential Solutions

### 1. Connection Pooling
Create multiple database connections and distribute operations across them:
```typescript
class ConnectionPool {
    async acquire(): Promise<DatabaseConnection> { ... }
    release(conn: DatabaseConnection): void { ... }
}
```
**Pros**: True parallelism, standard pattern
**Cons**: Complexity, resource management

### 2. Savepoints for Nested Transactions
Use SAVEPOINT instead of BEGIN for nested operations:
```typescript
await db.execute('SAVEPOINT sp_' + uuid);
// ... operations ...
await db.execute('RELEASE SAVEPOINT sp_' + uuid);
```
**Pros**: Works with single connection
**Cons**: Still serializes at database level, limited parallelism

### 3. Operation Queue
Serialize all write operations through a queue:
```typescript
class WriteQueue {
    async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        await this.lock.acquire();
        try { return await fn(); }
        finally { this.lock.release(); }
    }
}
```
**Pros**: Simple, predictable
**Cons**: No parallelism for writes

### 4. Batch Writes Only
Modify API to encourage batch operations over parallel single operations:
```typescript
// Instead of parallel single creates
await Promise.all(items.map(i => entityOps.createAll('file', [i])));

// Use batch create
await entityOps.createAll('file', items);  // Single transaction
```
**Pros**: Works today, efficient
**Cons**: API change, doesn't help all use cases

## Workaround
For now, serialize write operations or use batch operations:

```typescript
// Option 1: Serial writes
for (const item of items) {
    await collect(entityOps.createAll('file', [item]));
}

// Option 2: Batch writes (preferred)
await collect(entityOps.createAll('file', items));
```

## Test File
`perf/ems/entity-parallel.perf.ts` - Documents this limitation with benchmarks

## Impact
- Single-process applications: No impact (naturally serial)
- Multi-worker applications: Must serialize writes or use batching
- High-throughput write scenarios: Limited to ~16-22K serial ops/sec

## Related
- `src/ems/connection.ts` - Database connection creation
- `src/ems/entity-ops.ts` - Entity operations API
- `src/ems/ring/5/50-sql-create.ts` - Transaction wrapper
- `perf/ems/entity-compare.perf.ts` - Serial performance benchmarks
