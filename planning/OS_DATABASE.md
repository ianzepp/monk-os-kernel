# Database Channels

Database access from userspace via the Channel primitive.

---

## Overview

Database channels provide userspace access to external databases (PostgreSQL, SQLite) through the standard channel API. This is distinct from the kernel's internal StorageEngine which backs entity storage and VFS.

**Use cases:**
- Application databases (user data, analytics, logs)
- Legacy system integration
- Multi-database architectures
- Local SQLite for app-specific storage

**Not for:**
- Kernel entity storage (use StorageEngine)
- VFS backing store (use StorageEngine)

---

## Design Decisions

### 1. Always Stream Rows

Query results are always streamed as `item` responses, never batched into a single `ok`:

```typescript
// Query response (always streams)
{ op: 'item', data: { id: 1, name: 'Alice' } }
{ op: 'item', data: { id: 2, name: 'Bob' } }
{ op: 'done' }

// Execute response (no rows)
{ op: 'ok', data: { affectedRows: 5 } }
```

**Rationale:** Consumer has one code path for all queries. HAL always does `for (const row of rows) yield respond.item(row)`.

### 2. Dynamic SQL via Unsafe Methods

Userspace sends SQL as strings. HAL uses `sql.unsafe()` or equivalent:

```typescript
// Message from userspace
{ op: 'query', data: { sql: 'SELECT * FROM users WHERE id = $1', params: [123] } }

// HAL implementation
const rows = await sql.unsafe(msg.data.sql, msg.data.params);
```

**Rationale:** Database channels connect to user-managed databases, not kernel storage. SQL injection is the user's responsibility.

### 3. One Connection Per Channel

No connection pooling in v1. Each `channel.open()` creates one database connection:

```typescript
const db1 = await channel.open('postgres', 'postgresql://localhost/mydb');
const db2 = await channel.open('postgres', 'postgresql://localhost/mydb');
// db1 and db2 are separate connections
```

**Rationale:** OS is young. Pooling adds complexity. Transactions require consistent connection anyway.

### 4. POSIX-Style Errors

Database errors map to closest POSIX error code with database details in message:

```typescript
{
    op: 'error',
    data: {
        code: 'EIO',
        message: '23505: duplicate key value violates unique constraint "users_email_key"'
    }
}
```

**Error mapping:**
| Situation | POSIX Code |
|-----------|------------|
| Query/execute failure | EIO |
| Connection failed | ECONNREFUSED |
| Connection lost | ECONNRESET |
| Timeout | ETIMEDOUT |
| Invalid SQL | EINVAL |
| Permission denied | EACCES |

### 5. Transactions via Explicit SQL

No special transaction messages. Use standard SQL:

```typescript
await channel.call(db, { op: 'execute', data: { sql: 'BEGIN' } });
await channel.call(db, { op: 'execute', data: { sql: 'INSERT INTO ...' } });
await channel.call(db, { op: 'execute', data: { sql: 'COMMIT' } });
```

Works because of 1:1 connection mapping (Decision #3).

---

## Message Format

### Query (returns rows)

```typescript
// Request
{
    op: 'query',
    data: {
        sql: 'SELECT * FROM users WHERE active = $1',
        params?: [true]
    }
}

// Response (streamed)
{ op: 'item', data: { id: 1, name: 'Alice', active: true } }
{ op: 'item', data: { id: 2, name: 'Bob', active: true } }
{ op: 'done' }

// Empty result
{ op: 'done' }

// Error
{ op: 'error', data: { code: 'EIO', message: '42P01: relation "users" does not exist' } }
```

### Execute (no rows)

```typescript
// Request
{
    op: 'execute',
    data: {
        sql: 'UPDATE users SET active = $1 WHERE id = $2',
        params?: [false, 123]
    }
}

// Response
{ op: 'ok', data: { affectedRows: 1 } }

// DDL (no affected count)
{ op: 'ok' }

// Error
{ op: 'error', data: { code: 'EIO', message: '23505: duplicate key...' } }
```

---

## PostgreSQL Channel

### Implementation

```typescript
class BunPostgresChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'postgres';
    readonly description: string;

    private sql: SQL;
    private _closed = false;

    constructor(url: string, _opts?: ChannelOpts) {
        this.description = url;
        this.sql = new SQL(url);
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        try {
            switch (msg.op) {
                case 'query': {
                    const { sql, params } = msg.data as QueryData;
                    const rows = await this.sql.unsafe(sql, params ?? []);

                    for (const row of rows) {
                        yield respond.item(row);
                    }
                    yield respond.done();
                    break;
                }

                case 'execute': {
                    const { sql, params } = msg.data as QueryData;
                    const result = await this.sql.unsafe(sql, params ?? []);

                    // result.count for affected rows (if available)
                    yield respond.ok({ affectedRows: result.count });
                    break;
                }

                default:
                    yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            }
        } catch (err) {
            const pgErr = err as PostgresError;
            yield respond.error('EIO', `${pgErr.code}: ${pgErr.message}`);
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('PostgreSQL channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('PostgreSQL channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
        this.sql.close();
    }
}

interface QueryData {
    sql: string;
    params?: unknown[];
}
```

### Bun.sql API Notes

```typescript
import { SQL } from "bun";

// Connection
const sql = new SQL("postgres://user:pass@localhost/db");
const sql = new SQL({ url: "...", max: 10 }); // with options

// Safe template literal (static SQL)
const users = await sql`SELECT * FROM users WHERE id = ${id}`;

// Unsafe dynamic SQL (our use case)
const rows = await sql.unsafe(sqlString, params);

// Result is array-like with additional properties
rows.length    // row count
rows.count     // affected rows (for INSERT/UPDATE/DELETE)
rows.command   // 'SELECT', 'INSERT', etc.

// Close
sql.close();
```

### Phase 2: LISTEN/NOTIFY

```typescript
// Request
{ op: 'listen', data: { channel: 'events' } }

// Response (streaming events)
{ op: 'event', data: { channel: 'events', payload: '{"type":"user_created",...}' } }
{ op: 'event', data: { channel: 'events', payload: '...' } }
// ... continues until close
```

---

## SQLite Channel

### Use Case

Userspace applications need local SQLite databases separate from kernel storage:

```typescript
// App-specific database
const db = await channel.open('sqlite', '/data/myapp/app.db');

// In-memory database
const db = await channel.open('sqlite', ':memory:');

// Read-only
const db = await channel.open('sqlite', '/data/shared.db', { readonly: true });
```

### Design Decision: Host Paths Only

SQLite channels access host filesystem directly. This is not VFS:

```typescript
const db = await channel.open('sqlite', '/var/data/myapp.db');
const db = await channel.open('sqlite', ':memory:');
```

**Rationale:** Channels are for external resources. SQLite channel = "I have a SQLite database on the host filesystem." For VFS-abstracted storage, use StorageEngine.

### Options

| Option | Default | Notes |
|--------|---------|-------|
| `create` | `true` | Create database file if missing |
| `readonly` | `false` | Open read-only |
| WAL mode | Enabled | Better concurrency, set automatically |

### Implementation

```typescript
import { Database } from "bun:sqlite";

class BunSqliteChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'sqlite';
    readonly description: string;

    private db: Database;
    private _closed = false;

    constructor(path: string, opts?: ChannelOpts) {
        this.description = path;
        this.db = new Database(path, {
            readonly: opts?.readonly,
            create: opts?.create ?? true,
        });

        // Enable WAL for better concurrency
        this.db.exec('PRAGMA journal_mode = WAL');
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        try {
            switch (msg.op) {
                case 'query': {
                    const { sql, params } = msg.data as QueryData;
                    const stmt = this.db.prepare(sql);
                    const rows = stmt.all(...(params ?? []));

                    for (const row of rows) {
                        yield respond.item(row);
                    }
                    yield respond.done();
                    break;
                }

                case 'execute': {
                    const { sql, params } = msg.data as QueryData;
                    const stmt = this.db.prepare(sql);
                    const result = stmt.run(...(params ?? []));

                    yield respond.ok({ affectedRows: result.changes });
                    break;
                }

                default:
                    yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            }
        } catch (err) {
            const sqliteErr = err as Error;
            yield respond.error('EIO', sqliteErr.message);
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('SQLite channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('SQLite channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
        this.db.close();
    }
}
```

### ChannelOpts Extension

```typescript
interface ChannelOpts {
    // Existing
    headers?: Record<string, string>;
    keepAlive?: boolean;
    timeout?: number;
    database?: string;

    // SQLite-specific
    readonly?: boolean;
    create?: boolean;  // Create file if missing (default: true)
}
```

---

## Userspace Library

From `planning/OS_CHANNEL_LIBS.md`, the Database library wraps channels:

```typescript
// rom/lib/database.ts

import { channel, sqlQuery, sqlExecute } from '/lib/process';

export class Database {
    private ch: number;
    readonly protocol: string;

    static async connect(url: string): Promise<Database> {
        let protocol: string;
        if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
            protocol = 'postgres';
        } else if (url.startsWith('sqlite://') || url.startsWith('/') || url === ':memory:') {
            protocol = 'sqlite';
        } else {
            throw new Error(`Unsupported database URL: ${url}`);
        }

        const ch = await channel.open(protocol, url);
        return new Database(ch, protocol);
    }

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows: T[] = [];
        for await (const r of channel.stream(this.ch, sqlQuery(sql, params))) {
            if (r.op === 'item') rows.push(r.data as T);
            if (r.op === 'error') throw new DatabaseError(r.data.code, r.data.message);
            if (r.op === 'done') break;
        }
        return rows;
    }

    async execute(sql: string, params?: unknown[]): Promise<number | undefined> {
        const r = await channel.call(this.ch, sqlExecute(sql, params));
        if (r.op === 'error') throw new DatabaseError(r.data.code, r.data.message);
        return r.data?.affectedRows;
    }

    async close(): Promise<void> {
        await channel.close(this.ch);
    }
}
```

---

## Implementation Plan

### Phase 1: Core Support

- [x] PostgreSQL channel (`BunPostgresChannel`)
  - [x] `query` op with parameter binding
  - [x] `execute` op with affected row count
  - [x] Error mapping to POSIX codes
  - [x] Connection lifecycle

- [x] SQLite channel (`BunSqliteChannel`)
  - [x] Host path support
  - [x] `:memory:` support
  - [x] WAL mode by default
  - [x] `readonly` option

- [x] Channel device updates
  - [x] Register `sqlite` protocol in `BunChannelDevice.open()`
  - [x] Add SQLite options to `ChannelOpts`

- [x] Tests
  - [ ] PostgreSQL channel (requires test database)
  - [x] SQLite channel (in-memory)

### Phase 2: Streaming & Events

- [ ] Cursor support for large result sets
- [ ] PostgreSQL LISTEN/NOTIFY
- [ ] Connection health checks

### Phase 3: Production Features

- [ ] Connection pooling (optional)
- [ ] Prepared statement caching
- [ ] Query timeout

---

## References

- [Bun.sql PostgreSQL](https://bun.sh/docs/api/sql)
- [Bun SQLite](https://bun.sh/docs/api/sqlite)
- `planning/OS_CHANNELS.md` - Channel design
- `planning/OS_CHANNEL_LIBS.md` - Userspace libraries
- `src/hal/channel.ts` - Current implementation
