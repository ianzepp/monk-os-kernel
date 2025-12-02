# Storage Engine V2: Unified Entity & Blob Architecture

> **Status**: Planning
> **Created**: December 2024
> **Goal**: Realize the "every file is both a database and a row" vision

---

## 1. Problem Statement

### Current Architecture

The existing StorageEngine is a simple key-value blob store:

```typescript
interface StorageEngine {
    get(key: string): Promise<Uint8Array | null>;
    put(key: string, value: Uint8Array): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix: string): AsyncIterable<string>;
    // ...
}
```

VFS models serialize metadata to JSON and store under keys like `entity:{uuid}`:

```typescript
// FileModel.create()
await ctx.hal.storage.put(
    `entity:${id}`,
    new TextEncoder().encode(JSON.stringify(entity))
);

// FileModel.stat()
const data = await ctx.hal.storage.get(`entity:${id}`);
const entity = JSON.parse(new TextDecoder().decode(data));
```

### Problems

1. **Full table scans**: `FolderModel.list()` iterates ALL entities, parses JSON, filters in JavaScript:
   ```typescript
   async *list(ctx, id) {
       for await (const key of ctx.hal.storage.list('entity:')) {
           const data = await ctx.hal.storage.get(key);
           const entity = JSON.parse(new TextDecoder().decode(data));
           if (entity.parent === id) yield entity.id;  // O(n) scan!
       }
   }
   ```

2. **No query capability**: Can't find files by attributes (mtime, owner, size, mimetype).

3. **JSON encode/decode overhead**: Every operation parses/serializes.

4. **In-memory blob loading**: `FileHandleImpl` loads entire blob at open time:
   ```typescript
   // FileModel.open() - loads ALL content into memory
   const blobData = await ctx.hal.storage.get(`data:${entity.data}`);
   content = blobData ?? new Uint8Array(0);
   ```

5. **Bytes vs messages inconsistency**: VFS layer uses bytes, but kernel is message-driven. Translation happens mid-stack rather than at boundaries.

---

## 2. Vision

From AGENTS.md:

> "Everything is a file, everything has a UUID, everything can be queried as a database row."

The dual nature:
- **File AS a row**: Metadata lives in proper SQL columns (id, parent, name, owner, mtime) with indexes
- **File AS content**: Blob data stored separately, streamed as messages

Key principle from the message-driven architecture:

> "Bytes are acceptable at a network/file boundary, but only long enough to be chunked in or out of a message."

---

## 3. New Architecture

### Component Separation

| Component | Purpose | Backing Store |
|-----------|---------|---------------|
| **StorageEngine** | Entity metadata, relationships, queries | SQLite database |
| **BlobStore** | File content streaming | Filesystem directory |

```
┌─────────────────────────────────────────────────────────────┐
│  Kernel Handle Layer                                         │
│  - All operations are messages: exec(msg) → AsyncIterable   │
├─────────────────────────────────────────────────────────────┤
│  VFS Models                                                  │
│  - FileModel, FolderModel, DeviceModel, etc.                │
│  - Use StorageEngine for metadata                           │
│  - Use BlobStore for content streaming                      │
├─────────────────────────────────────────────────────────────┤
│  HAL Layer                                                   │
│  ├── StorageEngine (entities table, SQL queries)            │
│  └── BlobStore (message-oriented blob I/O)                  │
├─────────────────────────────────────────────────────────────┤
│  I/O Boundaries (bytes exist only here)                      │
│  ├── SQLite database file                                   │
│  └── Blob files on host filesystem                          │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Process syscall { op: 'file:read', fd }
    → Handle.exec({ op: 'recv' })
        → BlobStore.read(blobId)
            → [I/O boundary] Bun.file(path).stream()
            → yield { op: 'chunk', data: Uint8Array }  ← bytes wrapped immediately
        ← messages flow up through kernel
    ← ProcessIOHandle, taps, routing
← to process as messages
```

Messages all the way through the kernel. Bytes only at true I/O boundaries.

---

## 4. StorageEngine V2: Entity Store

### Schema

```sql
-- All VFS entities in one table
CREATE TABLE entities (
    id TEXT PRIMARY KEY,              -- UUID
    model TEXT NOT NULL,              -- 'file', 'folder', 'device', 'proc', 'link'
    parent TEXT,                      -- parent UUID (NULL for root)
    name TEXT NOT NULL,               -- filename
    owner TEXT NOT NULL,              -- owner UUID
    size INTEGER NOT NULL DEFAULT 0,  -- content size (files only)
    mtime INTEGER NOT NULL,           -- modification time (ms)
    ctime INTEGER NOT NULL,           -- creation time (ms)
    blob TEXT,                        -- blob ID reference (files only)
    mimetype TEXT,                    -- MIME type (files only)
    meta TEXT,                        -- JSON for model-specific extensions

    FOREIGN KEY (parent) REFERENCES entities(id) ON DELETE CASCADE
);

-- Critical indexes for common operations
CREATE INDEX idx_entities_parent ON entities(parent);
CREATE INDEX idx_entities_parent_name ON entities(parent, name);  -- path lookup
CREATE INDEX idx_entities_model ON entities(model);
CREATE INDEX idx_entities_mtime ON entities(mtime);
CREATE INDEX idx_entities_owner ON entities(owner);
CREATE UNIQUE INDEX idx_entities_parent_name_unique ON entities(parent, name);
```

### Interface

```typescript
/**
 * Entity as stored in database.
 * Core fields are columns; extensions go in `meta`.
 */
interface Entity {
    id: string;
    model: 'file' | 'folder' | 'device' | 'proc' | 'link';
    parent: string | null;
    name: string;
    owner: string;
    size: number;
    mtime: number;
    ctime: number;
    blob?: string;      // blob ID for files
    mimetype?: string;
    meta?: Record<string, unknown>;
}

/**
 * Query options for entity lookup.
 */
interface QueryOptions {
    parent?: string;              // filter by parent
    model?: Entity['model'];      // filter by model type
    owner?: string;               // filter by owner
    where?: WhereClause[];        // additional conditions
    orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>;
    limit?: number;
    offset?: number;
}

interface WhereClause {
    field: string;
    op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IN';
    value: unknown;
}

/**
 * StorageEngine V2 - Entity storage with queries.
 */
interface StorageEngine {
    // Entity CRUD
    createEntity(entity: Entity): Promise<void>;
    getEntity(id: string): Promise<Entity | null>;
    updateEntity(id: string, fields: Partial<Entity>): Promise<void>;
    deleteEntity(id: string): Promise<void>;

    // Query
    query(opts: QueryOptions): AsyncIterable<Entity>;

    // Path resolution helper
    getByPath(parent: string, name: string): Promise<Entity | null>;

    // Transactions
    begin(): Promise<Transaction>;

    // Watch for changes
    watch(opts: WatchOptions): AsyncIterable<EntityEvent>;

    // Lifecycle
    close(): Promise<void>;
}

interface Transaction {
    createEntity(entity: Entity): Promise<void>;
    updateEntity(id: string, fields: Partial<Entity>): Promise<void>;
    deleteEntity(id: string): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
```

### Example Usage

```typescript
// FolderModel.list() - now a simple indexed query
async *list(ctx: ModelContext, id: string): AsyncIterable<string> {
    for await (const entity of ctx.hal.storage.query({ parent: id })) {
        yield entity.id;
    }
}

// Find files modified in last hour
const recent = ctx.hal.storage.query({
    model: 'file',
    where: [{ field: 'mtime', op: '>', value: Date.now() - 3600000 }],
    orderBy: [{ field: 'mtime', dir: 'desc' }],
    limit: 100
});

// Path resolution
const entity = await ctx.hal.storage.getByPath(parentId, 'filename.txt');
```

---

## 5. BlobStore: Message-Oriented Content

### Design Principles

1. **Messages, not bytes**: BlobStore yields `{ op: 'chunk', data }` messages directly
2. **Streaming**: Never load full blob into memory
3. **Filesystem backing**: Blobs stored as files, named by UUID
4. **Content-addressable option**: Future support for deduplication via content hashing

### Blob File Layout

```
{dataDir}/
├── aa/
│   ├── aabbccdd-1234-5678-9abc-def012345678
│   └── aabbccee-1234-5678-9abc-def012345679
├── ab/
│   └── abcdef01-2345-6789-abcd-ef0123456789
└── ...
```

Two-character prefix directories (like git objects) to avoid filesystem limits on directory entries.

### Interface

```typescript
interface BlobStat {
    size: number;
    mtime: number;
}

interface ReadOptions {
    offset?: number;    // start position
    limit?: number;     // max bytes to read
    chunkSize?: number; // chunk size for streaming (default 64KB)
}

/**
 * BlobStore - Message-oriented blob storage.
 *
 * All read operations yield Response messages directly.
 * Bytes only exist at the filesystem boundary.
 */
interface BlobStore {
    /**
     * Stream blob content as chunk messages.
     * Yields: { op: 'chunk', data: Uint8Array } for each chunk
     * Yields: { op: 'done' } when complete
     * Yields: { op: 'error', ... } on failure
     */
    read(id: string, opts?: ReadOptions): AsyncIterable<Response>;

    /**
     * Write blob content from chunk messages.
     * Consumes messages until 'done' or 'error'.
     * Returns final blob size.
     */
    write(id: string, chunks: AsyncIterable<Response>): Promise<number>;

    /**
     * Create blob from single Uint8Array (convenience for small blobs).
     * Used at I/O boundaries where bytes are already materialized.
     */
    writeBytes(id: string, data: Uint8Array): Promise<void>;

    /**
     * Append to existing blob.
     */
    append(id: string, data: Uint8Array): Promise<void>;

    /**
     * Truncate blob to size.
     */
    truncate(id: string, size: number): Promise<void>;

    /**
     * Get blob metadata.
     */
    stat(id: string): Promise<BlobStat | null>;

    /**
     * Check if blob exists.
     */
    exists(id: string): Promise<boolean>;

    /**
     * Delete blob.
     */
    delete(id: string): Promise<void>;

    /**
     * Lifecycle.
     */
    close(): Promise<void>;
}
```

### Implementation Notes

```typescript
class FilesystemBlobStore implements BlobStore {
    constructor(private dataDir: string) {}

    private pathFor(id: string): string {
        // aa/aabbccdd-... layout
        const prefix = id.substring(0, 2);
        return path.join(this.dataDir, prefix, id);
    }

    async *read(id: string, opts?: ReadOptions): AsyncIterable<Response> {
        const filePath = this.pathFor(id);
        const file = Bun.file(filePath);

        if (!await file.exists()) {
            yield respond.error('ENOENT', `Blob not found: ${id}`);
            return;
        }

        const chunkSize = opts?.chunkSize ?? 65536;
        const stream = file.stream();
        const reader = stream.getReader();

        try {
            let offset = 0;
            const startOffset = opts?.offset ?? 0;
            const limit = opts?.limit ?? Infinity;
            let bytesYielded = 0;

            while (bytesYielded < limit) {
                const { value, done } = await reader.read();
                if (done) break;

                // Handle offset/limit
                let chunk = value;
                if (offset < startOffset) {
                    const skip = startOffset - offset;
                    if (skip >= chunk.length) {
                        offset += chunk.length;
                        continue;
                    }
                    chunk = chunk.slice(skip);
                    offset = startOffset;
                }

                if (bytesYielded + chunk.length > limit) {
                    chunk = chunk.slice(0, limit - bytesYielded);
                }

                yield respond.chunk(chunk);
                bytesYielded += chunk.length;
                offset += chunk.length;
            }

            yield respond.done();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        } finally {
            reader.releaseLock();
        }
    }

    async write(id: string, chunks: AsyncIterable<Response>): Promise<number> {
        const filePath = this.pathFor(id);
        await this.ensureDir(id);

        const file = Bun.file(filePath);
        const writer = file.writer();
        let totalBytes = 0;

        try {
            for await (const response of chunks) {
                if (response.op === 'done') break;
                if (response.op === 'error') {
                    throw new Error(response.message);
                }
                if (response.op === 'chunk' && response.data) {
                    const bytes = response.data as Uint8Array;
                    writer.write(bytes);
                    totalBytes += bytes.length;
                }
            }
            await writer.end();
            return totalBytes;
        } catch (err) {
            await writer.end();
            throw err;
        }
    }
}
```

---

## 6. VFS Model Changes

### FileModel

```typescript
class FileModel extends PosixModel {
    async create(ctx, parent, name, fields?): Promise<string> {
        const id = ctx.hal.entropy.uuid();
        const blobId = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();

        // Create empty blob
        await ctx.hal.blobs.writeBytes(blobId, new Uint8Array(0));

        // Create entity with blob reference
        await ctx.hal.storage.createEntity({
            id,
            model: 'file',
            parent,
            name,
            owner: fields?.owner ?? ctx.caller,
            size: 0,
            mtime: now,
            ctime: now,
            blob: blobId,
            mimetype: fields?.mimetype,
        });

        return id;
    }

    async open(ctx, id, flags, opts?): Promise<FileHandle> {
        const entity = await ctx.hal.storage.getEntity(id);
        if (!entity) throw new ENOENT(`File not found: ${id}`);

        // Return handle that streams from/to BlobStore
        // No content loaded into memory!
        return new StreamingFileHandle(ctx, entity, flags);
    }
}
```

### StreamingFileHandle

```typescript
/**
 * File handle that streams content via BlobStore messages.
 * No in-memory buffering of full content.
 */
class StreamingFileHandle implements FileHandle {
    private position = 0;

    constructor(
        private ctx: ModelContext,
        private entity: Entity,
        private flags: OpenFlags
    ) {
        if (flags.append) {
            this.position = entity.size;
        }
        if (flags.truncate && flags.write) {
            // Truncate on open
            ctx.hal.blobs.truncate(entity.blob!, 0);
            entity.size = 0;
        }
    }

    /**
     * Stream read - yields chunk messages directly from BlobStore.
     */
    async *read(size?: number): AsyncIterable<Response> {
        if (!this.flags.read) {
            yield respond.error('EACCES', 'Not opened for reading');
            return;
        }

        yield* this.ctx.hal.blobs.read(this.entity.blob!, {
            offset: this.position,
            limit: size,
        });

        // Update position (would need to track bytes yielded)
    }

    // ... similar for write
}
```

### FolderModel

```typescript
class FolderModel extends PosixModel {
    async *list(ctx, id): AsyncIterable<string> {
        // Simple indexed query - no more full table scan!
        for await (const entity of ctx.hal.storage.query({ parent: id })) {
            yield entity.id;
        }
    }
}
```

---

## 7. HAL Integration

### BunHAL Changes

```typescript
interface HAL {
    // Existing devices
    clock: ClockDevice;
    entropy: EntropyDevice;
    console: ConsoleDevice;
    // ...

    // V2: Separated storage
    storage: StorageEngine;  // Entity metadata + queries
    blobs: BlobStore;        // Content streaming
}

class BunHAL implements HAL {
    readonly storage: StorageEngine;
    readonly blobs: BlobStore;

    constructor(config: HALConfig) {
        // SQLite for entities
        this.storage = new SqliteStorageEngine(config.dbPath ?? ':memory:');

        // Filesystem for blobs
        this.blobs = new FilesystemBlobStore(config.blobDir ?? './data/blobs');
    }
}
```

### Configuration

```typescript
interface OSConfig {
    storage?: {
        // SQLite database path
        database?: string;  // default: ':memory:' or './data/monk.db'

        // Blob storage directory
        blobDir?: string;   // default: './data/blobs'
    };
}

// Usage
const os = new OS({
    storage: {
        database: './data/monk.db',
        blobDir: './data/blobs',
    }
});
```

---

## 8. Migration Path

### Phase 1: Add New Interfaces
- Implement `StorageEngine` V2 with entities table
- Implement `BlobStore` with filesystem backing
- Add to HAL alongside existing storage

### Phase 2: Migrate Models
- Update `FileModel` to use new interfaces
- Update `FolderModel` to use query-based listing
- Update `DeviceModel`, `ProcModel`

### Phase 3: Update Handles
- Replace `FileHandleImpl` with `StreamingFileHandle`
- Ensure message-oriented flow throughout

### Phase 4: Cleanup
- Remove old `StorageEngine` key-value interface
- Remove JSON entity serialization from models
- Update tests

---

## 9. Future Considerations

### Content-Addressable Storage
- Hash blob content for deduplication
- Store as `{hash}` instead of `{uuid}`
- Entity.blob references content hash

### Full-Text Search
- SQLite FTS5 extension for content indexing
- Query file contents, not just metadata

### Versioning
- Blob versioning via copy-on-write
- Entity.version tracks revisions
- Historical queries

### Distributed Storage
- BlobStore backed by S3/R2
- StorageEngine backed by PostgreSQL
- Same interfaces, different implementations

---

## 10. Open Questions

1. **Blob garbage collection**: When entity deleted, when to delete blob? Reference counting? Async GC?

2. **Atomic operations**: How to ensure entity + blob created/deleted atomically?

3. **Large file handling**: Multipart uploads? Chunked writes with commit?

4. **Cache layer**: In-memory LRU cache for hot blobs? At which layer?

5. **Permissions in queries**: Filter by ACL in SQL, or post-filter in model layer?
