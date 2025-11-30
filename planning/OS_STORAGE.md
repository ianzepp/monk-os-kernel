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
// File identity is UUID, path computed from name + parent chain
{
    id: '019d3f2a-7b4c-7d8e-9f0a-1b2c3d4e5f6b',
    model: 'file',
    name: 'doc.txt',             // filename only
    parent: '019d3f2a-...',      // folder UUID
    data: '019d3f2a-...',        // blob UUID (content-addressable)
    owner: '019d3f2a-...',       // process UUID that created it
}

// Path computed by walking parent chain: /home/user/doc.txt
// Moving a file = updating parent field only
// Renaming a file = updating name field only
// Two files sharing data = same data UUID, different file UUIDs
// Uniqueness enforced by (parent, name) constraint
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

### FolderModel

Organizational container for files and other folders.

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID v7 identity |
| model | string | `'folder'` |
| name | string | Folder name (unique within parent) |
| parent | string | Parent folder UUID (null for root) |
| owner | string | Owner UUID |
| mtime | number | Last modification time (ms epoch) |
| ctime | number | Creation time (ms epoch) |

**No `data` field** - folders have no content blob.

**Path is computed** - walk parent chain to build full path.

**Children are not stored** - derived via query:
```typescript
// List folder contents
vfs.list('/home/user/documents')
// → SELECT * FROM entities WHERE parent = '019d...'
```

**Operations:**
- `stat()` → returns folder fields
- `read()` → error (use `list()`)
- `write()` → error
- `list()` → query children by parent UUID

### FileModel

Standard file storage backed by StorageEngine.

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID v7 identity |
| model | string | `'file'` |
| name | string | Filename (unique within parent) |
| parent | string | Parent folder UUID |
| data | string | Blob UUID (content-addressable) |
| owner | string | Owner UUID |
| size | number | Content size in bytes |
| mtime | number | Last modification time (ms epoch) |
| ctime | number | Creation time (ms epoch) |
| mimetype | string | Content type (optional) |

**Path is computed** - walk parent chain to build full path.

**Backing store:** StorageEngine
- Metadata: stored as JSON in `entity:{id}` key
- Content: stored as blob in `data:{data}` key

**Flow control:** Transactions
- Metadata + content updates are atomic
- Concurrent writes serialize via storage transactions

**No deduplication:** Each file owns its blob. `unlink()` deletes both entity and data.

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
| id | string | Process UUID |
| parent | string | Parent process UUID |
| state | string | Process state |
| cmd | string | Command line |
| cwd | string | Working directory |

**Path format:** `/proc/{uuid}/...`

| Path | Content |
|------|---------|
| `/proc/{uuid}/status` | Process status as text |
| `/proc/{uuid}/fd` | Directory of open file descriptors |
| `/proc/{uuid}/env` | Environment variables |

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

## Access Control

### Philosophy

No UNIX-style user/group/other permission bits. Instead, explicit grants to specific UUIDs (users, processes, roles) with explicit operations.

**Key principles:**
- Grants are explicit, not inherited
- Deny always wins over grants
- Operations are model-defined
- Check happens once at `open()`, not every I/O call
- FileHandle *is* the capability

### ACL Structure

```typescript
interface ACL {
    /** Explicit grants */
    grants: Grant[];

    /** Explicit denies (always wins) */
    deny: string[];  // UUIDs
}

interface Grant {
    /** Who receives the grant (user, process, role UUID) */
    to: string;

    /** What operations are permitted */
    ops: string[];

    /** Optional expiration (ms since epoch) */
    expires?: number;
}
```

### Operations by Model

Each model defines what operations are valid:

| Model | Operations |
|-------|------------|
| file | `read`, `write`, `delete`, `stat`, `*` |
| folder | `list`, `create`, `delete`, `stat`, `*` |
| network | `connect`, `listen`, `stat`, `*` |
| device | `read`, `write`, `stat`, `*` |
| proc | `signal`, `stat`, `*` |

`*` grants all operations (full control).

### The `access()` Syscall

Single syscall for reading and modifying ACLs:

```typescript
// Read ACLs
access(path: string): Promise<ACL>

// Set ACLs (replaces existing)
access(path: string, acl: ACL): Promise<void>

// Clear ACLs (reset to creator-only)
access(path: string, null): Promise<void>
```

**Examples:**

```typescript
// Read current ACLs
const acl = await vfs.access('/home/user/doc.txt');
// { grants: [...], deny: [...] }

// Grant read access
await vfs.access('/home/user/doc.txt', {
    grants: [
        { to: '019d...', ops: ['read', 'stat'] },
        { to: '019d...', ops: ['*'] },  // full control
    ],
    deny: [],
});

// Add a grant (read-modify-write)
const acl = await vfs.access('/home/user/doc.txt');
acl.grants.push({ to: '019d...', ops: ['read'] });
await vfs.access('/home/user/doc.txt', acl);

// Revoke all access (creator-only)
await vfs.access('/home/user/doc.txt', null);
```

### Permission Check Flow

```
┌─────────────────────────────────────────────────────────┐
│  vfs.open('/path', ['read', 'write'])                  │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  1. Load ACL for path                                   │
│  2. Check: caller in deny[]?  → EPERM                   │
│  3. Check: caller has required ops in grants[]?         │
│     - Direct match, or                                  │
│     - Has '*' grant                                     │
│  4. No match? → EPERM                                   │
│  5. Match? → Return FileHandle                          │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  FileHandle is the capability                           │
│  - read() / write() → no further checks                 │
│  - handle authorized at open() time                     │
└─────────────────────────────────────────────────────────┘
```

### Who Can Modify ACLs?

| Operation | Required Permission |
|-----------|---------------------|
| `access(path)` (read) | `stat` op on path |
| `access(path, acl)` (set) | `*` op on path |
| `access(path, null)` (clear) | `*` op on path |

### Default ACLs

On entity creation, ACL defaults to:

```typescript
{
    grants: [{ to: creator_uuid, ops: ['*'] }],
    deny: [],
}
```

Creator has full control. No one else has access until explicitly granted.

### Access Storage

Access data is stored separately from entity metadata:

```
entity:{uuid}     → { id, model, path, parent, ... }  // stat() data
access:{uuid}     → { grants: [...], deny: [...] }    // access() data
data:{uuid}       → raw bytes                         // read() data
```

This keeps `stat()` lean and allows access queries without loading entity data.

## Storage Quotas

### Philosophy

Quotas are a property of mount points, not arbitrary folders. Each mount has its own quota based on its backing store.

**Key principles:**
- Only mount points have quotas
- No inheritance or parent walking - find mount, check quota
- Hard limits only (EDQUOT on exceed)
- Soft limits are application concern

### Mount Quota Structure

```typescript
interface MountQuota {
    /** Maximum bytes allowed (null = unlimited) */
    bytes_limit: number | null;

    /** Current bytes used */
    bytes_used: number;
}
```

### Example Mount Table

```
/                     → RootMount, 100MB quota
/home/bob             → LocalMount to /dev/sda1, 2TB quota
/home/bob/docs        → (no mount, inherits /home/bob)
/tmp                  → MemoryMount, 512MB quota
/dev                  → DeviceMount, no quota (virtual)
/proc                 → ProcMount, no quota (virtual)
```

### Write Flow

```
write('/home/bob/docs/file.txt', data)
    │
    ▼
VFS finds mount for path → /home/bob
    │
    ▼
Check: mount.quota.bytes_used + data.length <= bytes_limit?
    │
    ├─ Yes → proceed, update bytes_used
    └─ No  → EDQUOT (quota exceeded)
```

### The `quota()` Syscall

```typescript
// Read quota for mount containing path
quota(path: string): Promise<MountQuota>

// Set quota on mount point (requires * on mount path)
quota(mountPath: string, limits: { bytes_limit: number }): Promise<void>

// Clear quota (unlimited)
quota(mountPath: string, null): Promise<void>
```

**Examples:**

```typescript
// Check quota for a path
const q = await vfs.quota('/home/bob/docs/file.txt');
// Returns quota for /home/bob mount
// { bytes_limit: 2000000000000, bytes_used: 45000000 }

// Set quota on mount point
await vfs.quota('/home/bob', { bytes_limit: 1_000_000_000_000 });

// Remove quota (unlimited)
await vfs.quota('/tmp', null);
```

### Who Can Modify Quotas?

| Operation | Required Permission |
|-----------|---------------------|
| `quota(path)` (read) | `stat` op on mount |
| `quota(path, limits)` (set) | `*` op on mount |
| `quota(path, null)` (clear) | `*` op on mount |

### Storage Keys

```
mount:{path}    → { path, model, device, quota: { bytes_limit, bytes_used } }
```

Quota is stored as part of mount metadata, not separately.

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

## File Versioning (Optional Feature)

**Implement after core VFS is stable.**

Opt-in automatic versioning for text files. Every write creates a new version - no explicit commit required.

### Scope

- **Text files only** - binary files use normal overwrite behavior
- **Opt-in** - not enabled by default
- **Linear history** - no branching

### Activation Modes

```typescript
// Per-open: version this session's writes
const handle = await vfs.open('/doc.txt', 'rw', { versioned: true });

// Per-file: mark file as versioned (all future writes)
await vfs.setstat('/doc.txt', { versioned: true });

// Per-mount: all text files in mount are versioned
await vfs.mount('/projects', storage, { versioned: true });
```

### API

```typescript
interface VFS {
    // Open specific version (read-only)
    open(path, flags, opts?: { version?: number; versioned?: boolean }): Promise<FileHandle>;

    // Get version history
    versions(path: string): Promise<VersionInfo[]>;

    // Diff between versions of same file
    diff(path: string, from: number, to: number): Promise<TextDiff>;

    // Diff between two files
    diff(pathA: string, pathB: string): Promise<TextDiff>;
}

interface VersionInfo {
    version: number;
    mtime: number;
    size: number;
    author: string;  // process/user UUID
}

interface TextDiff {
    hunks: DiffHunk[];
}

interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffLine[];
}

interface DiffLine {
    op: '+' | '-' | ' ';
    content: string;
}
```

### Storage Layout

```
entity:{uuid}       → { ..., versioned: true, version: 5 }
version:{uuid}:{n}  → { blob: sha256, mtime, size, author }
blob:{sha256}       → raw bytes (content-addressable, refcounted)
```

When versioning is enabled:
- `data:{uuid}` is replaced by `version:{uuid}:{n}` entries
- Blobs are content-addressable (SHA-256 hash)
- Blobs are refcounted for deduplication across versions
- Blob GC runs when refcount hits zero

### Open Questions (Versioning)

1. **Retention policy** - Keep all versions forever? Last N? Time-based? Configurable per-mount?
2. **Diff algorithm** - Myers diff? Patience diff? Configurable?

---

## Open Questions

### 10. Network model - listen() semantics
How does a server listen? Options: separate path (`/dev/tcp/listen/8080`), separate syscall, or listener as file where `read()` returns connections. TBD.

## Resolved Questions

1. **Symlinks**: No symlinks. Two files sharing data have the same `data` UUID. Indirection is handled by queries or application logic, not filesystem primitives.

2. **Directories**: `folder` is a separate model from `file`. Folders have no `data` field. Children are derived via query (`WHERE parent = folder_uuid`), not stored on the folder.

3. **Permissions**: Grant-based ACLs, separate from stat(). See "Access Control" section.

4. **Quotas**: Mount-level quotas only. See "Storage Quotas" section.

5. **Caching**: No caching for now. Every call hits StorageEngine. Profile first, optimize later.

6. **Rename/move atomicity + Path uniqueness**: No `path` field on entity. Store `name` + `parent` instead. Path computed by walking parent chain. Uniqueness enforced by `(parent, name)` constraint. Future optimization: cache parent relationships (not full paths).

7. **Parent folder existence**: VFS enforces. Create fails with ENOENT if parent folder doesn't exist. Caller must create parents first (like UNIX).

8. **Orphan blob cleanup**: No deduplication. Each file owns its blob. `unlink()` deletes both `entity:{uuid}` and `data:{uuid}`. No orphans, no GC needed.

9. **Access check on parent traversal**: Check only the target, not parents. If you have permission on `/home/bob/docs/public/file.txt`, you can access it even without permission on `/home/bob/docs`. Path is navigation, not security boundary.

10. **FileHandle revocation**: Handles can be forcibly revoked. `revoke()` invalidates the handle immediately. Next I/O on revoked handle fails with EBADF. No negotiation - like process kill.

11. **watch() semantics**: Minimal event on any entity mutation. `WatchEvent { entity: uuid, op: 'create'|'update'|'delete', fields: string[] }`. Application-level (emitted from StorageEngine on put/delete), not database-level. Cross-process only works with PostgreSQL LISTEN/NOTIFY. Refine granularity later based on need.

12. **Quota accounting on delete**: VFS handles quota accounting on unlink. Decrement `bytes_used` by file's size, then delete entity + data. No shared blobs, so no ownership ambiguity.

13. **ProcModel pid field**: No pid. Process identity is UUID. Path is `/proc/{uuid}/...`. Consistent with everything else.
