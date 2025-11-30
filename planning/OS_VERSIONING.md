# OS Versioning

Automatic file versioning in the VFS layer - every write optionally creates a new version,
with full history and diff support.

## Motivation

Traditional filesystems are destructive - writes overwrite previous content. Recovery requires
external backup systems. Monk VFS can do better by treating version history as a first-class
feature, similar to:

- Git (but per-file, automatic, no staging)
- ZFS snapshots (but per-file granularity)
- Dropbox/Google Drive version history

**Use cases:**

1. **Configuration files** - see what changed, when, roll back bad configs
2. **Documents** - collaborative editing with history
3. **Audit logs** - immutable append-only with verifiable history
4. **Code files** - lightweight versioning without full git ceremony

## Data Model

### Hybrid Storage Architecture

Versioning builds on the hybrid storage model:

- **Database (StorageEngine)** - metadata, version history, ACLs
- **Filesystem (BlobStore)** - immutable content blobs

```
Database:
  entity:{uuid} → metadata + version chain
  access:{uuid} → ACL

BlobStore (/var/monk/data/):
  {blob-uuid-1} → content bytes (version 1)
  {blob-uuid-2} → content bytes (version 2)
  {blob-uuid-3} → content bytes (version 3)
```

### Entity Schema (Versioned)

```typescript
interface VersionedEntity extends ModelStat {
    // Standard fields
    id: string;
    model: 'file';
    name: string;
    parent: string;
    owner: string;
    size: number;           // current version size
    mtime: number;          // current version mtime
    ctime: number;
    data: string;           // current version blob UUID

    // Versioning fields
    versioned: boolean;     // true if versioning enabled
    version: number;        // current version number (1-indexed)
    versions: VersionEntry[];
}

interface VersionEntry {
    version: number;        // version number
    data: string;           // blob UUID for this version
    size: number;           // bytes
    mtime: number;          // when this version was created
    author?: string;        // who created this version (caller UUID)
    message?: string;       // optional commit message
    checksum?: string;      // content hash for integrity
}
```

### Example Entity

```json
{
    "id": "0195e8a1-1234-7000-8000-000000000001",
    "model": "file",
    "name": "config.json",
    "parent": "0195e8a0-...",
    "owner": "0195e800-...",
    "size": 201,
    "mtime": 1701234610000,
    "ctime": 1701234500000,
    "data": "0195e8a3-1234-7000-8000-000000000003",
    "versioned": true,
    "version": 3,
    "versions": [
        {
            "version": 1,
            "data": "0195e8a1-1234-7000-8000-000000000001",
            "size": 142,
            "mtime": 1701234500000,
            "author": "0195e800-..."
        },
        {
            "version": 2,
            "data": "0195e8a2-1234-7000-8000-000000000002",
            "size": 156,
            "mtime": 1701234550000,
            "author": "0195e800-...",
            "message": "Added cache settings"
        },
        {
            "version": 3,
            "data": "0195e8a3-1234-7000-8000-000000000003",
            "size": 201,
            "mtime": 1701234610000,
            "author": "0195e800-...",
            "message": "Increased timeout"
        }
    ]
}
```

## BlobStore Interface

Content storage abstraction, separate from metadata:

```typescript
interface BlobStore {
    /**
     * Get blob content as readable stream.
     * Returns null if blob doesn't exist.
     */
    get(id: string): Promise<ReadableStream<Uint8Array> | null>;

    /**
     * Get blob as bytes (for small files / diff).
     */
    getBytes(id: string): Promise<Uint8Array | null>;

    /**
     * Store blob content. ID should be pre-generated UUID.
     */
    put(id: string, data: ReadableStream<Uint8Array> | Uint8Array): Promise<void>;

    /**
     * Delete a blob.
     */
    delete(id: string): Promise<void>;

    /**
     * Check if blob exists and get size.
     */
    stat(id: string): Promise<{ size: number } | null>;

    /**
     * List all blob IDs (for GC).
     */
    list(): AsyncIterable<string>;
}
```

### Implementations

```typescript
// Local filesystem
class FilesystemBlobStore implements BlobStore {
    constructor(private root: string) {}

    async get(id: string): Promise<ReadableStream | null> {
        const file = Bun.file(path.join(this.root, id));
        if (!await file.exists()) return null;
        return file.stream();
    }

    async put(id: string, data: ReadableStream | Uint8Array): Promise<void> {
        await Bun.write(path.join(this.root, id), data);
    }

    async delete(id: string): Promise<void> {
        await fs.unlink(path.join(this.root, id));
    }
}

// S3-compatible (future)
class S3BlobStore implements BlobStore {
    constructor(private bucket: string, private client: S3Client) {}
    // ...
}
```

## API Surface

### VFS Methods

```typescript
interface VFS {
    // Existing methods work with current version by default
    open(path, flags, caller, opts?: OpenOptions): Promise<FileHandle>;
    stat(path, caller): Promise<ModelStat>;

    // Version-specific operations
    versions(path: string, caller: string): Promise<VersionInfo[]>;
    diff(path: string, caller: string, opts: DiffOptions): Promise<Diff>;
    restore(path: string, caller: string, opts: RestoreOptions): Promise<void>;
}

interface OpenOptions {
    /** Read a specific version (read-only) */
    version?: number;

    /** Auto-create version on close if modified (default: true for versioned files) */
    autocommit?: boolean;

    /** Commit message for this edit session */
    message?: string;
}

interface VersionInfo {
    version: number;
    size: number;
    mtime: number;
    author?: string;
    message?: string;
    checksum?: string;
}

interface DiffOptions {
    /** Version to diff from (default: version - 1) */
    from?: number;

    /** Version to diff to (default: current) */
    to?: number;

    /** Context lines for unified diff */
    context?: number;
}

interface RestoreOptions {
    /** Version to restore */
    version: number;

    /** Message for the restore commit */
    message?: string;
}
```

### Syscalls

```typescript
// List versions
versions(path: string): Promise<VersionInfo[]>

// Get diff between versions
diff(path: string, from?: number, to?: number): Promise<Diff>

// Restore old version (creates new version with old content)
restore(path: string, version: number): Promise<void>

// Explicit commit point (when autocommit is false)
commit(fd: number, message?: string): Promise<number>  // returns new version number
```

### Process Library

```typescript
// List file versions
const history = await versions('/etc/config.json');
// → [{ version: 1, mtime: ..., size: 142 }, ...]

// Open specific version (read-only)
const fd = await open('/etc/config.json', { read: true }, { version: 2 });
const oldContent = await read(fd);
await close(fd);

// Diff versions
const changes = await diff('/etc/config.json', 1, 3);
console.log(changes.unified);  // unified diff string

// Restore old version
await restore('/etc/config.json', 1);
// Creates version 4 with same content as version 1

// Manual commit control
const fd = await open('/etc/config.json', { write: true }, { autocommit: false });
await write(fd, chunk1);
await commit(fd, 'Partial update');  // version N+1
await write(fd, chunk2);
await commit(fd, 'Complete update'); // version N+2
await close(fd);
```

## Version Creation Behavior

### When Versions Are Created

| Trigger | Behavior |
|---------|----------|
| `close()` with `autocommit: true` (default) | Create version if file was modified |
| `commit(fd)` explicit call | Create version immediately |
| `close()` with `autocommit: false` | No version created, changes in "working" state |

### Write Flow (Versioned File)

```
open('/config.json', { write: true })
    │
    ▼
write(fd, data)  ──► buffer to temp blob or current blob
    │
    ▼
close(fd)
    │
    ├── autocommit: true + dirty?
    │       │
    │       ▼
    │   1. Finalize blob in BlobStore
    │   2. Create new VersionEntry
    │   3. Update entity.version, entity.data
    │   4. Append to entity.versions[]
    │
    └── autocommit: false
            │
            ▼
        Just close handle, changes in current blob
        (no version entry created)
```

### Enabling Versioning

```typescript
// Enable on existing file
await setstat('/config.json', caller, { versioned: true });
// Current content becomes version 1

// Create file with versioning enabled
const fd = await open('/new.txt', { write: true, create: true });
await write(fd, content);
await close(fd);
await setstat('/new.txt', caller, { versioned: true });

// Or via mount options (all files in mount are versioned)
vfs.mount('/versioned', model, { versioned: true });
```

## Diff Implementation

### Diff Structure

```typescript
interface Diff {
    /** Path of file */
    path: string;

    /** Source version */
    from: number;

    /** Target version */
    to: number;

    /** True if binary file (no line diff) */
    binary: boolean;

    /** Line-based changes (text files only) */
    hunks?: DiffHunk[];

    /** Unified diff string */
    unified?: string;

    /** Summary stats */
    stats: {
        additions: number;
        deletions: number;
        changes: number;
    };
}

interface DiffHunk {
    /** Starting line in 'from' version */
    fromStart: number;
    fromCount: number;

    /** Starting line in 'to' version */
    toStart: number;
    toCount: number;

    /** Lines in this hunk */
    lines: DiffLine[];
}

interface DiffLine {
    type: 'context' | 'add' | 'delete';
    content: string;
}
```

### Diff Algorithm

For text files, use Myers diff algorithm (same as git):

```typescript
async function diff(
    path: string,
    caller: string,
    opts: DiffOptions
): Promise<Diff> {
    const entity = await this.getEntity(path);

    const fromVersion = opts.from ?? entity.version - 1;
    const toVersion = opts.to ?? entity.version;

    const fromEntry = entity.versions.find(v => v.version === fromVersion);
    const toEntry = entity.versions.find(v => v.version === toVersion);

    const fromBytes = await this.blobStore.getBytes(fromEntry.data);
    const toBytes = await this.blobStore.getBytes(toEntry.data);

    // Detect binary
    if (isBinary(fromBytes) || isBinary(toBytes)) {
        return {
            path,
            from: fromVersion,
            to: toVersion,
            binary: true,
            stats: { additions: 0, deletions: 0, changes: 1 }
        };
    }

    const fromLines = decode(fromBytes).split('\n');
    const toLines = decode(toBytes).split('\n');

    const hunks = myersDiff(fromLines, toLines, opts.context ?? 3);

    return {
        path,
        from: fromVersion,
        to: toVersion,
        binary: false,
        hunks,
        unified: formatUnified(path, fromVersion, toVersion, hunks),
        stats: computeStats(hunks)
    };
}
```

### Binary Detection

```typescript
function isBinary(data: Uint8Array): boolean {
    // Check first 8KB for null bytes
    const sample = data.slice(0, 8192);
    return sample.includes(0);
}
```

## Garbage Collection

With versioning, blob lifecycle is more complex. A blob is referenced if:
- Any entity has it as current `data`
- Any entity has it in `versions[].data`

### GC Algorithm

```typescript
async function collectGarbage(): Promise<{ deleted: number; bytes: number }> {
    // 1. Build set of all referenced blobs
    const referenced = new Set<string>();

    for await (const key of storage.list('entity:')) {
        const entity = await storage.get(key);
        if (entity.data) {
            referenced.add(entity.data);
        }
        if (entity.versions) {
            for (const v of entity.versions) {
                referenced.add(v.data);
            }
        }
    }

    // 2. Scan blobs, delete unreferenced
    let deleted = 0;
    let bytes = 0;

    for await (const blobId of blobStore.list()) {
        if (!referenced.has(blobId)) {
            const stat = await blobStore.stat(blobId);
            await blobStore.delete(blobId);
            deleted++;
            bytes += stat?.size ?? 0;
        }
    }

    return { deleted, bytes };
}
```

### GC Triggers

- **On boot** - clean up orphans from crashes
- **Periodic timer** - every hour or configurable interval
- **Manual syscall** - `gc()` for admin use
- **Threshold** - when blob count or size exceeds limits

## Retention Policies

Not all versions need to be kept forever. Policies:

```typescript
interface RetentionPolicy {
    /** Keep at least this many versions */
    minVersions?: number;

    /** Keep versions from the last N days */
    maxAgeDays?: number;

    /** Keep at most this many versions */
    maxVersions?: number;

    /** Keep all versions (default) */
    keepAll?: boolean;
}
```

### Policy Application

```typescript
async function applyRetention(entityId: string, policy: RetentionPolicy): Promise<void> {
    const entity = await getEntity(entityId);
    if (!entity.versioned || !entity.versions) return;

    const now = Date.now();
    const maxAge = policy.maxAgeDays ? policy.maxAgeDays * 24 * 60 * 60 * 1000 : Infinity;
    const minVersions = policy.minVersions ?? 1;
    const maxVersions = policy.maxVersions ?? Infinity;

    // Sort by version descending (newest first)
    const sorted = [...entity.versions].sort((a, b) => b.version - a.version);

    const keep: VersionEntry[] = [];
    const remove: VersionEntry[] = [];

    for (let i = 0; i < sorted.length; i++) {
        const v = sorted[i];
        const age = now - v.mtime;

        const withinMinCount = i < minVersions;
        const withinMaxCount = i < maxVersions;
        const withinMaxAge = age < maxAge;

        if (withinMinCount || (withinMaxCount && withinMaxAge)) {
            keep.push(v);
        } else {
            remove.push(v);
        }
    }

    // Update entity, blobs cleaned up by GC
    entity.versions = keep.sort((a, b) => a.version - b.version);
    await saveEntity(entity);
}
```

### Policy Configuration

```typescript
// Per-file
await setstat('/logs/app.log', caller, {
    retention: { maxVersions: 10, maxAgeDays: 30 }
});

// Per-mount (default for all files in mount)
vfs.mount('/logs', model, {
    versioned: true,
    retention: { maxVersions: 100, maxAgeDays: 90 }
});
```

## Migration Path

### Enabling Versioning on Existing File

```typescript
async function enableVersioning(path: string, caller: string): Promise<void> {
    const entity = await getEntity(path);

    if (entity.versioned) return;  // already enabled

    // Current content becomes version 1
    entity.versioned = true;
    entity.version = 1;
    entity.versions = [{
        version: 1,
        data: entity.data,
        size: entity.size,
        mtime: entity.mtime,
        author: caller,
        message: 'Initial version (versioning enabled)'
    }];

    await saveEntity(entity);
}
```

### Disabling Versioning

```typescript
async function disableVersioning(path: string, caller: string): Promise<void> {
    const entity = await getEntity(path);

    if (!entity.versioned) return;

    // Keep current version, drop history
    // Old blobs cleaned up by GC
    entity.versioned = false;
    entity.version = undefined;
    entity.versions = undefined;

    await saveEntity(entity);
}
```

## Implementation Phases

### Phase 1: BlobStore Abstraction

1. Define `BlobStore` interface
2. Implement `FilesystemBlobStore`
3. Refactor `FileModel` to use BlobStore for `data:*` keys
4. Update HAL/VFS initialization to configure BlobStore path
5. Tests for BlobStore operations

### Phase 2: Basic Versioning

1. Add versioning fields to entity schema
2. Implement version creation on `close()` with autocommit
3. Add `versions()` VFS method and syscall
4. Add `version` option to `open()` for reading old versions
5. Tests for version creation and listing

### Phase 3: Diff Support

1. Implement Myers diff algorithm
2. Add binary detection
3. Add `diff()` VFS method and syscall
4. Unified diff output formatting
5. Tests for diff operations

### Phase 4: Restore and Commit

1. Add `restore()` VFS method and syscall
2. Add `commit()` syscall for explicit commits
3. Add `autocommit` option to `open()`
4. Tests for restore and manual commit

### Phase 5: Retention and GC

1. Add retention policy to entity schema
2. Implement policy application
3. Update GC to handle versioned blobs
4. Add admin syscalls for GC and retention
5. Tests for retention policies

## Open Questions

1. **Checksum algorithm** - SHA-256? BLAKE3? Store in version entry for integrity?

2. **Compression** - Compress blobs in BlobStore? Or leave to filesystem?

3. **Delta storage** - Store binary deltas between versions to save space? Adds complexity.

4. **Branch/fork** - Allow branching version history? Probably overkill for v1.

5. **Conflict resolution** - Two processes write simultaneously. Last write wins? Merge? For v1, last close wins (same as non-versioned).

6. **Streaming large files** - Version creation needs to finalize blob. For very large files, this could be slow. Stream to temp blob, then atomic rename?

## Related Documents

- `OS_STORAGE.md` - VFS architecture, models, ACL
- `OS.md` - System overview
