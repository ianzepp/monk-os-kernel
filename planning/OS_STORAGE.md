# Monk OS Storage Architecture

## Philosophy

**Everything is a file. Everything is a database. Files are database rows.**

**Everything has a UUID.**

This merges Plan 9's "everything is a file" with BeOS's database-centric filesystem:

- **Plan 9**: Uniform namespace, all resources accessed via file operations
- **BeOS**: Files have queryable attributes, filesystem is a database
- **UUID-first**: Identity is a UUID, paths and names are just indexed fields

In Monk OS, the **Model** is the unifying concept. Every path maps to a model, and the model determines:
- What metadata fields exist (schema)
- Where bytes come from on read
- Where bytes go on write
- How flow control works

## UUID Identity

Every entity in the system has a UUID as its primary identity:

```typescript
interface Entity {
    /** Primary identity - UUID v7 */
    id: string;
}
```

**UUID v7** is used because:
- Timestamp-sortable (created_at ordering is free)
- Better index locality in storage
- Still random enough to be unguessable

**What gets a UUID:**

| Entity | Old ID | UUID Identity |
|--------|--------|---------------|
| Process | PID (number) | `019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6a` |
| File | inode/path | `019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6b` |
| File descriptor | fd (number) | `019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6c` |
| Socket | fd (number) | `019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6d` |
| Content blob | - | `019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6e` |

**Short form for display:** `019d..5f6a` (4 leading + `..` + 4 trailing)

```typescript
function shortId(uuid: string): string {
    const clean = uuid.replace(/-/g, '');
    return `${clean.slice(0, 4)}..${clean.slice(-4)}`;
}

// '019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6a' → '019d..5f6a'
```

**Path is not identity:**

```typescript
// File identity is UUID, path is a field
{
    id: '019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6b',
    path: '/home/user/doc.txt',  // indexed, queryable
    content: '019d3f2a-...',     // blob UUID (content-addressable)
    owner: '019d3f2a-...',       // process UUID that created it
}

// Moving a file = updating path field, id unchanged
// Two paths to same content = same content UUID, different file UUIDs
// Querying by path = index lookup, not identity lookup
```

**Source:** `HAL.entropy.uuid()` generates all UUIDs.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                          VFS                                │
│                                                             │
│   open("/dev/tcp/10.0.0.1:80")                             │
│        │                                                    │
│        ▼                                                    │
│   path_to_model(path) → NetworkModel                       │
│        │                                                    │
│        ▼                                                    │
│   model.open(path) → FileHandle                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
      ┌─────────┐       ┌──────────┐       ┌──────────┐
      │  file   │       │ network  │       │  device  │
      │  Model  │       │  Model   │       │  Model   │
      └────┬────┘       └────┬─────┘       └────┬─────┘
           │                 │                  │
           ▼                 ▼                  ▼
      ┌─────────┐       ┌──────────┐       ┌──────────┐
      │ Storage │       │  Socket  │       │  Kernel  │
      │ Engine  │       │  (HAL)   │       │ Handler  │
      └─────────┘       └──────────┘       └──────────┘
```

## Core Concepts

### Model

A Model defines how a class of files behaves:

```typescript
interface Model {
    /** Model identifier (e.g., 'file', 'network', 'device') */
    readonly name: string;

    /** Schema definition for stat() fields */
    fields(): FieldDef[];

    /** Open a path, returning a handle for I/O */
    open(path: string, flags: OpenFlags): Promise<FileHandle>;

    /** Get metadata fields for a path */
    stat(path: string): Promise<ModelStat>;

    /** Update metadata fields */
    setstat(path: string, fields: Partial<ModelStat>): Promise<void>;

    /** Create a new instance at path */
    create(path: string, fields?: Partial<ModelStat>): Promise<void>;

    /** Remove instance at path */
    unlink(path: string): Promise<void>;

    /** List children (for directory-like models) */
    list(path: string): AsyncIterable<string>;

    /** Watch for changes */
    watch?(path: string, pattern?: string): AsyncIterable<WatchEvent>;
}
```

### FileHandle

A FileHandle is the result of opening a path. It provides I/O operations:

```typescript
interface FileHandle extends AsyncDisposable {
    /** Read bytes from current position */
    read(size?: number): Promise<Uint8Array>;

    /** Write bytes at current position */
    write(data: Uint8Array): Promise<number>;

    /** Seek to position (for seekable models) */
    seek?(offset: number, whence: 'start' | 'current' | 'end'): Promise<number>;

    /** Flush pending writes */
    sync(): Promise<void>;

    /** Close handle and release resources */
    close(): Promise<void>;
}
```

### stat() vs read()

**Critical distinction:**

- `stat(path)` → Returns model fields (metadata, schema-defined)
- `read(handle)` → Returns content bytes (opaque to model)

```typescript
// File model
const meta = await vfs.stat('/home/user/doc.txt');
// { size: 1024, mtime: 1701234567890, owner: 'user', mimetype: 'text/plain' }

const handle = await vfs.open('/home/user/doc.txt', 'r');
const content = await handle.read();
// Uint8Array containing file bytes
```

## Built-in Models

### FileModel

Standard file storage backed by StorageEngine.

| Field | Type | Description |
|-------|------|-------------|
| size | number | Content size in bytes |
| mtime | number | Last modification time (ms epoch) |
| ctime | number | Creation time (ms epoch) |
| owner | string | Owner identifier |
| mode | number | Permission bits |
| mimetype | string | Content type (optional) |

**Backing store:** StorageEngine
- Metadata: stored as JSON in `meta:{path}` key
- Content: stored as blob in `blob:{path}` key

**Flow control:** Transactions
- Metadata + content updates are atomic
- Concurrent writes serialize via storage transactions

### NetworkModel

Network connections as files.

| Field | Type | Description |
|-------|------|-------------|
| proto | string | Protocol ('tcp', 'udp') |
| local | string | Local address:port |
| remote | string | Remote address:port |
| state | string | Connection state |
| rx_bytes | number | Bytes received |
| tx_bytes | number | Bytes transmitted |

**Path format:** `/dev/tcp/{host}:{port}` or `/dev/udp/{host}:{port}`

**Backing store:** HAL NetworkDevice
- `open()` → `network.connect(host, port)`
- `read()` → `socket.read()`
- `write()` → `socket.write()`

**Flow control:** Backpressure
- Write returns bytes actually sent
- Caller must handle partial writes
- Read blocks until data available (with optional timeout)

### DeviceModel

Kernel device access.

| Field | Type | Description |
|-------|------|-------------|
| type | string | Device type |
| driver | string | Driver/handler name |
| readonly | boolean | Write capability |

**Examples:**

| Path | Handler | read() | write() |
|------|---------|--------|---------|
| `/dev/console` | ConsoleDevice | readline() | write() |
| `/dev/random` | EntropyDevice | bytes() | (error) |
| `/dev/null` | NullDevice | (empty) | (discard) |
| `/dev/zero` | ZeroDevice | (zeros) | (discard) |

**Flow control:** Device-specific
- Console: queued reads (FIFO)
- Entropy: immediate (never blocks)
- Null/Zero: immediate

### ProcModel

Process information (read-only virtual files).

| Field | Type | Description |
|-------|------|-------------|
| pid | number | Process ID |
| ppid | number | Parent process ID |
| state | string | Process state |
| cmd | string | Command line |
| cwd | string | Working directory |

**Path format:** `/proc/{pid}/...`

| Path | Content |
|------|---------|
| `/proc/{pid}/status` | Process status as text |
| `/proc/{pid}/fd` | Directory of open file descriptors |
| `/proc/{pid}/env` | Environment variables |

**Backing store:** Kernel process table (in-memory)

**Flow control:** None (read-only snapshots)

## Path Resolution

The VFS resolves paths to models via mount table:

```typescript
interface MountTable {
    // Path prefix → Model mapping
    mounts: Map<string, Model>;

    resolve(path: string): { model: Model; relpath: string };
}
```

**Default mount table:**

| Prefix | Model |
|--------|-------|
| `/dev/tcp/` | NetworkModel (TCP) |
| `/dev/udp/` | NetworkModel (UDP) |
| `/dev/` | DeviceModel |
| `/proc/` | ProcModel |
| `/sys/` | SysModel |
| `/` | FileModel (default) |

Resolution is longest-prefix match:
- `/dev/tcp/localhost:80` → NetworkModel, relpath=`localhost:80`
- `/dev/console` → DeviceModel, relpath=`console`
- `/home/user/file.txt` → FileModel, relpath=`home/user/file.txt`

## Transactions and Atomicity

### File Model Transactions

File operations should be atomic when possible:

```typescript
// Atomic metadata + content update
await using tx = await vfs.begin('/home/user/doc.txt');
await tx.setstat({ mtime: Date.now() });
await tx.write(newContent);
await tx.commit();
// If exception before commit, changes are rolled back
```

Implementation uses StorageEngine transactions:

```typescript
class FileModel implements Model {
    async begin(path: string): Promise<FileTransaction> {
        const tx = await this.storage.begin();
        return new FileTransaction(path, tx);
    }
}
```

### Cross-Model Transactions

Not supported at HAL/VFS level. Higher layers (application) must implement saga patterns or two-phase commit if needed.

## User-Defined Models (Future)

Phase 2 will allow users to define custom models:

```typescript
// Define schema
const taskSchema = {
    name: 'task',
    fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'status', type: 'string', enum: ['pending', 'done'] },
        { name: 'due', type: 'number' },
        { name: 'tags', type: 'string[]' },
    ],
};

// Register model
await vfs.write('/sys/models/task', encode(taskSchema));

// Create instances
await vfs.create('/home/user/tasks/todo-1', {
    model: 'task',
    fields: { title: 'Write docs', status: 'pending' },
});

// Query by fields (BeOS-style)
for await (const path of vfs.query('model:task AND status:pending')) {
    console.log(path);
}
```

User-defined models are backed by FileModel (StorageEngine) but add:
- Schema validation on write
- Queryable fields (indexed in storage)
- Optional computed fields
- Optional custom read/write transforms

## Flow Control Summary

| Model | Strategy | Rationale |
|-------|----------|-----------|
| file | Transactions | ACID semantics for persistence |
| network | Backpressure | Stream semantics, producer/consumer |
| device | Per-device | Console queues, entropy immediate |
| proc | None | Read-only snapshots |
| user-defined | Transactions | Inherits from file model |

## Relationship to HAL

The Model layer sits between VFS and HAL:

```
┌─────────────┐
│     VFS     │  Path namespace, open/close/read/write
├─────────────┤
│   Models    │  Schema, routing, flow control
├─────────────┤
│     HAL     │  Raw device access
├─────────────┤
│     Bun     │  Runtime primitives
└─────────────┘
```

Models use HAL devices but don't expose them directly:
- FileModel uses StorageEngine
- NetworkModel uses NetworkDevice
- DeviceModel uses various HAL devices
- ProcModel uses kernel state (no HAL)

## Open Questions

1. **Directories**: Are directories a separate model, or implicit from path structure?

2. **Permissions**: Per-model permission checks, or unified in VFS?

3. **Quotas**: Storage quotas at model level or VFS level?

4. **Caching**: Should models cache stat() results? Invalidation strategy?

## Resolved Questions

1. **Symlinks**: No symlinks. Two files sharing content have the same `content` UUID. Indirection is handled by queries or application logic, not filesystem primitives.
