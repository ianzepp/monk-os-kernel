# Channel Libraries

> **Status:** Won't implement. External code uses native Bun APIs (fetch, Bun.sql) directly rather than OS-internal wrappers.

Higher-level libraries built on the Channel I/O primitive for common protocols.

## Overview

The channel syscalls (`channel.open`, `channel.call`, etc.) provide low-level protocol-aware messaging. These libraries provide ergonomic APIs for specific protocols:

| Library | Protocol | Import |
|---------|----------|--------|
| `rom/lib/http.ts` | HTTP/HTTPS | `/lib/http` |
| `rom/lib/database.ts` | PostgreSQL, MySQL | `/lib/database` |

## Design Principles

1. **Thin wrappers**: Libraries wrap channels, not replace them
2. **Resource management**: Automatic cleanup via `close()` or `using`
3. **Error propagation**: Channel errors surface as typed exceptions
4. **Streaming support**: First-class async iterables for large responses
5. **Zero dependencies**: Only import from `/lib/process`

## HTTP Library

### Interface

```typescript
// rom/lib/http.ts

export interface HttpOptions {
    /** Default headers for all requests */
    headers?: Record<string, string>;
    /** Request timeout in ms */
    timeout?: number;
    /** Base path prefix for all requests */
    basePath?: string;
}

export interface RequestOptions {
    /** Request-specific headers (merged with defaults) */
    headers?: Record<string, string>;
    /** Query parameters */
    query?: Record<string, string | number | boolean>;
    /** Request timeout override */
    timeout?: number;
}

export interface HttpResponse<T = unknown> {
    /** Response status (from channel response op) */
    ok: boolean;
    /** Response data */
    data: T;
}

export class Http {
    /**
     * Connect to an HTTP endpoint.
     */
    static async connect(baseUrl: string, opts?: HttpOptions): Promise<Http>;

    /**
     * GET request returning parsed JSON.
     */
    async get<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;

    /**
     * POST request with JSON body.
     */
    async post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;

    /**
     * PUT request with JSON body.
     */
    async put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;

    /**
     * PATCH request with JSON body.
     */
    async patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;

    /**
     * DELETE request.
     */
    async delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;

    /**
     * Stream response as async iterable (JSONL or SSE).
     */
    stream<T = unknown>(path: string, opts?: RequestOptions): AsyncIterable<T>;

    /**
     * Raw request with full control.
     */
    async request<T = unknown>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<HttpResponse<T>>;

    /**
     * Close the connection.
     */
    async close(): Promise<void>;
}
```

### Usage Examples

#### Basic Requests

```typescript
import { Http } from '/lib/http';

const api = await Http.connect('https://api.example.com', {
    headers: { 'Authorization': 'Bearer token123' }
});

try {
    // GET
    const users = await api.get<User[]>('/users');

    // GET with query params
    const filtered = await api.get<User[]>('/users', {
        query: { role: 'admin', active: true }
    });

    // POST with body
    const created = await api.post<User>('/users', {
        name: 'Alice',
        email: 'alice@example.com'
    });

    // PUT
    await api.put(`/users/${created.id}`, { name: 'Alice Smith' });

    // DELETE
    await api.delete(`/users/${created.id}`);

} finally {
    await api.close();
}
```

#### Streaming

```typescript
import { Http } from '/lib/http';

const api = await Http.connect('https://stream.example.com');

// Stream JSONL responses
for await (const event of api.stream<Event>('/events')) {
    console.log('Event:', event);
}

await api.close();
```

#### Error Handling

```typescript
import { Http, HttpError } from '/lib/http';

const api = await Http.connect('https://api.example.com');

try {
    const user = await api.get('/users/999');
} catch (err) {
    if (err instanceof HttpError) {
        console.log(`HTTP ${err.status}: ${err.message}`);
        // err.status = 404
        // err.code = 'HTTP_404'
    }
}
```

### Implementation

```typescript
// rom/lib/http.ts

import { channel, httpRequest, type Message, type Response } from '/lib/process';

export class HttpError extends Error {
    code: string;
    status: number;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.status = parseInt(code.replace('HTTP_', '')) || 0;
        this.name = 'HttpError';
    }
}

export class Http {
    private ch: number;
    private baseUrl: string;
    private defaultHeaders: Record<string, string>;
    private basePath: string;
    private defaultTimeout?: number;

    private constructor(
        ch: number,
        baseUrl: string,
        opts?: HttpOptions
    ) {
        this.ch = ch;
        this.baseUrl = baseUrl;
        this.defaultHeaders = opts?.headers ?? {};
        this.basePath = opts?.basePath ?? '';
        this.defaultTimeout = opts?.timeout;
    }

    static async connect(baseUrl: string, opts?: HttpOptions): Promise<Http> {
        const ch = await channel.open('http', baseUrl, {
            headers: opts?.headers,
            timeout: opts?.timeout,
        });
        return new Http(ch, baseUrl, opts);
    }

    async get<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('GET', path, undefined, opts);
        return response.data;
    }

    async post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('POST', path, body, opts);
        return response.data;
    }

    async put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('PUT', path, body, opts);
        return response.data;
    }

    async patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('PATCH', path, body, opts);
        return response.data;
    }

    async delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
        const response = await this.request<T>('DELETE', path, undefined, opts);
        return response.data;
    }

    async *stream<T = unknown>(path: string, opts?: RequestOptions): AsyncIterable<T> {
        const msg = httpRequest({
            method: 'GET',
            path: this.basePath + path,
            query: opts?.query as Record<string, unknown>,
            headers: { ...this.defaultHeaders, ...opts?.headers },
            accept: 'application/jsonl',
        });

        for await (const response of channel.stream(this.ch, msg)) {
            if (response.op === 'error') {
                const err = response.data as { code: string; message: string };
                throw new HttpError(err.code, err.message);
            }
            if (response.op === 'item') {
                yield response.data as T;
            }
            if (response.op === 'done') {
                break;
            }
        }
    }

    async request<T = unknown>(
        method: string,
        path: string,
        body?: unknown,
        opts?: RequestOptions
    ): Promise<HttpResponse<T>> {
        const msg = httpRequest({
            method,
            path: this.basePath + path,
            query: opts?.query as Record<string, unknown>,
            headers: { ...this.defaultHeaders, ...opts?.headers },
            body,
        });

        const response = await channel.call<T>(this.ch, msg);

        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new HttpError(err.code, err.message);
        }

        return {
            ok: response.op === 'ok',
            data: response.data as T,
        };
    }

    async close(): Promise<void> {
        await channel.close(this.ch);
    }
}
```

## Database Library

### Interface

```typescript
// rom/lib/database.ts

export interface DatabaseOptions {
    /** Connection pool size (future) */
    poolSize?: number;
}

export interface QueryOptions {
    /** Query timeout in ms */
    timeout?: number;
}

export class Database {
    /**
     * Connect to a database.
     *
     * @param url - Connection URL (postgresql://..., mysql://...)
     */
    static async connect(url: string, opts?: DatabaseOptions): Promise<Database>;

    /**
     * Execute a query and return all rows.
     */
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

    /**
     * Execute a query and return the first row, or null.
     */
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;

    /**
     * Execute a statement (INSERT, UPDATE, DELETE, DDL).
     * Returns affected row count for DML, undefined for DDL.
     */
    async execute(sql: string, params?: unknown[]): Promise<number | undefined>;

    /**
     * Stream query results as async iterable.
     * Uses server-side cursor for memory efficiency.
     */
    cursor<T = Record<string, unknown>>(sql: string, params?: unknown[]): AsyncIterable<T>;

    /**
     * Execute multiple statements in a transaction.
     */
    async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

    /**
     * Close the connection.
     */
    async close(): Promise<void>;

    /** Protocol type (postgres, mysql) */
    readonly protocol: string;
}

export interface Transaction {
    /**
     * Execute a query within the transaction.
     */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

    /**
     * Execute a statement within the transaction.
     */
    execute(sql: string, params?: unknown[]): Promise<number | undefined>;
}
```

### Usage Examples

#### Basic Queries

```typescript
import { Database } from '/lib/database';

const db = await Database.connect('postgresql://localhost/myapp');

try {
    // Query all rows
    const users = await db.query<User>('SELECT * FROM users WHERE active = $1', [true]);

    // Query single row
    const user = await db.queryOne<User>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) {
        throw new Error('User not found');
    }

    // Insert
    await db.execute(
        'INSERT INTO users (name, email) VALUES ($1, $2)',
        ['Alice', 'alice@example.com']
    );

    // Update
    const affected = await db.execute(
        'UPDATE users SET name = $1 WHERE id = $2',
        ['Alice Smith', userId]
    );
    console.log(`Updated ${affected} rows`);

    // DDL
    await db.execute(`
        CREATE TABLE IF NOT EXISTS logs (
            id SERIAL PRIMARY KEY,
            message TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

} finally {
    await db.close();
}
```

#### Streaming Large Results

```typescript
import { Database } from '/lib/database';

const db = await Database.connect('postgresql://localhost/analytics');

// Stream millions of rows without loading all into memory
let count = 0;
for await (const row of db.cursor<Event>('SELECT * FROM events ORDER BY created_at')) {
    await processEvent(row);
    count++;

    if (count % 10000 === 0) {
        console.log(`Processed ${count} events`);
    }
}

await db.close();
```

#### Transactions

```typescript
import { Database } from '/lib/database';

const db = await Database.connect('postgresql://localhost/banking');

// Atomic transfer
await db.transaction(async (tx) => {
    const from = await tx.query<Account>(
        'SELECT * FROM accounts WHERE id = $1 FOR UPDATE',
        [fromId]
    );

    if (from[0].balance < amount) {
        throw new Error('Insufficient funds');
    }

    await tx.execute(
        'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
        [amount, fromId]
    );

    await tx.execute(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
        [amount, toId]
    );
});

await db.close();
```

#### Error Handling

```typescript
import { Database, DatabaseError } from '/lib/database';

const db = await Database.connect('postgresql://localhost/myapp');

try {
    await db.execute('INSERT INTO users (email) VALUES ($1)', ['duplicate@example.com']);
} catch (err) {
    if (err instanceof DatabaseError) {
        if (err.code === 'UNIQUE_VIOLATION') {
            console.log('Email already exists');
        }
    }
}
```

### Implementation

```typescript
// rom/lib/database.ts

import { channel, sqlQuery, sqlExecute, type Message, type Response } from '/lib/process';

export class DatabaseError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = 'DatabaseError';
    }
}

export class Database {
    private ch: number;
    readonly protocol: string;

    private constructor(ch: number, protocol: string) {
        this.ch = ch;
        this.protocol = protocol;
    }

    static async connect(url: string, _opts?: DatabaseOptions): Promise<Database> {
        // Detect protocol from URL
        let protocol: string;
        if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
            protocol = 'postgres';
        } else if (url.startsWith('mysql://')) {
            protocol = 'mysql';
        } else {
            throw new Error(`Unsupported database URL: ${url}`);
        }

        const ch = await channel.open(protocol, url);
        return new Database(ch, protocol);
    }

    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        const response = await channel.call(this.ch, sqlQuery(sql, params));

        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new DatabaseError(err.code, err.message);
        }

        return (response.data as T[]) ?? [];
    }

    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
        const rows = await this.query<T>(sql, params);
        return rows[0] ?? null;
    }

    async execute(sql: string, params?: unknown[]): Promise<number | undefined> {
        const msg = params ? sqlQuery(sql, params) : sqlExecute(sql);
        const response = await channel.call(this.ch, msg);

        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new DatabaseError(err.code, err.message);
        }

        // Return affected row count if available
        const data = response.data as { affectedRows?: number } | undefined;
        return data?.affectedRows;
    }

    async *cursor<T = Record<string, unknown>>(sql: string, params?: unknown[]): AsyncIterable<T> {
        const msg = sqlQuery(sql, params, true); // cursor: true

        for await (const response of channel.stream(this.ch, msg)) {
            if (response.op === 'error') {
                const err = response.data as { code: string; message: string };
                throw new DatabaseError(err.code, err.message);
            }
            if (response.op === 'item') {
                yield response.data as T;
            }
            if (response.op === 'done') {
                break;
            }
        }
    }

    async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
        await this.execute('BEGIN');

        try {
            const tx = new TransactionImpl(this);
            const result = await fn(tx);
            await this.execute('COMMIT');
            return result;
        } catch (err) {
            await this.execute('ROLLBACK');
            throw err;
        }
    }

    async close(): Promise<void> {
        await channel.close(this.ch);
    }
}

class TransactionImpl implements Transaction {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        return this.db.query<T>(sql, params);
    }

    execute(sql: string, params?: unknown[]): Promise<number | undefined> {
        return this.db.execute(sql, params);
    }
}
```

## Summary

### Import Patterns

```typescript
// Low-level channel access
import { channel, httpRequest, sqlQuery } from '/lib/process';

// High-level HTTP
import { Http } from '/lib/http';

// High-level Database
import { Database } from '/lib/database';
```

### Comparison

| Approach | Use Case |
|----------|----------|
| `channel.*` | Custom protocols, fine-grained control |
| `Http` | REST APIs, JSON services |
| `Database` | SQL databases, transactions |

## Future Considerations

### Additional Libraries

| Library | Protocol | Purpose |
|---------|----------|---------|
| `rom/lib/redis.ts` | Redis | Key-value, pub/sub |
| `rom/lib/graphql.ts` | GraphQL | Query/mutation client |
| `rom/lib/grpc.ts` | gRPC | RPC client |

### Connection Pooling

Database connections could support pooling:

```typescript
const db = await Database.connect('postgresql://localhost/myapp', {
    poolSize: 10,
    idleTimeout: 30000,
});
```

### Prepared Statements

```typescript
const stmt = await db.prepare('SELECT * FROM users WHERE id = $1');
const user1 = await stmt.query([1]);
const user2 = await stmt.query([2]);
await stmt.close();
```

### Query Builder

A type-safe query builder could layer on top:

```typescript
import { Query } from '/lib/query';

const users = await Query.from('users')
    .where('active', '=', true)
    .orderBy('created_at', 'desc')
    .limit(10)
    .execute(db);
```

## Source Files

| File | Purpose |
|------|---------|
| `rom/lib/process.ts` | Low-level channel syscalls |
| `rom/lib/http.ts` | HTTP client library |
| `rom/lib/database.ts` | Database client library |
