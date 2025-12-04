# OS Versioning

> **Status**: Not Implemented - Feasible with EMS
> **Depends on**: BlobStore (not implemented)

Automatic file versioning in the VFS layer - every write optionally creates a new version,
with full history and diff support.

---

## Feasibility Assessment (vs EMS)

### What EMS Already Provides

| Requirement | EMS Status | Notes |
|-------------|------------|-------|
| Change tracking infrastructure | ✅ `tracked` table | Records operation, changes JSON, created_by |
| Per-field tracking flag | ✅ `fields.tracked` | Can mark fields for audit |
| Observer pipeline | ✅ Ring 7 TrackedObserver | Hooks into mutations |
| File metadata table | ✅ `file` table | Has `data` column for blob reference |
| Blob storage reference | ⚠️ Schema only | `file.data` references "HAL block storage" |
| BlobStore implementation | ❌ Not implemented | **Blocker** - same as OS_STORAGE_V2 |

### Schema Changes Needed

The planning doc stores `versions[]` as JSON array in entity. EMS prefers normalized SQL:

```sql
-- New table for version history (EMS-style)
CREATE TABLE IF NOT EXISTS file_versions (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at  TEXT DEFAULT (datetime('now')),

    -- FK to file entity
    file_id     TEXT NOT NULL REFERENCES file(id) ON DELETE CASCADE,

    -- Version identity
    version     INTEGER NOT NULL,

    -- Blob reference (same as file.data)
    data        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    checksum    TEXT,

    -- Metadata
    author      TEXT,
    message     TEXT,

    UNIQUE(file_id, version)
);

CREATE INDEX IF NOT EXISTS idx_file_versions_file
    ON file_versions(file_id, version DESC);

-- Add versioning flag to file table
ALTER TABLE file ADD COLUMN versioned INTEGER DEFAULT 0;
ALTER TABLE file ADD COLUMN version INTEGER DEFAULT 1;
```

### Implementation Path

1. **BlobStore first** - Versioning is blocked until BlobStore exists (see OS_STORAGE_V2.md)
2. **Schema migration** - Add `file_versions` table and `file.versioned` column
3. **Observer extension** - Add Ring 5 observer for version creation on file close
4. **API/syscalls** - Add `versions()`, `diff()`, `restore()`, `commit()`

### Why It's Feasible

- EMS `tracked` table proves the pattern works (change history per record)
- Observer pipeline can hook file mutations at Ring 5 (SQL layer)
- Split-table design (entities + file) allows adding versioning without bloating core
- `file.data` already expects external blob reference

### Why It's Blocked

- **BlobStore not implemented** - Can't store immutable version blobs
- Without BlobStore, versions would overwrite same blob (defeats purpose)

---

## Original Design (For Reference)

### Motivation

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

### Data Model

#### Hybrid Storage Architecture

Versioning builds on the hybrid storage model:

- **Database (EMS)** - metadata, version history, ACLs
- **Filesystem (BlobStore)** - immutable content blobs

```
Database (EMS):
  entities    → id, model, parent, pathname
  file        → id, owner, data, size, versioned, version
  file_versions → file_id, version, data, size, author, message

BlobStore (/var/monk/data/):
  aa/{blob-uuid-1} → content bytes (version 1)
  ab/{blob-uuid-2} → content bytes (version 2)
  ...
```

#### Version Entry (SQL row, not JSON)

```typescript
interface FileVersion {
    id: string;           // row UUID
    file_id: string;      // FK to file.id
    version: number;      // version number (1-indexed)
    data: string;         // blob UUID in BlobStore
    size: number;         // bytes
    checksum?: string;    // content hash
    author?: string;      // who created this version
    message?: string;     // optional commit message
    created_at: string;   // timestamp
}
```

### API Surface

#### VFS Methods

```typescript
interface VFS {
    // Existing methods work with current version by default
    open(path, flags, caller, opts?: OpenOptions): Promise<FileHandle>;

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
```

#### Syscalls

```typescript
// List versions
versions(path: string): Promise<VersionInfo[]>

// Get diff between versions
diff(path: string, from?: number, to?: number): Promise<Diff>

// Restore old version (creates new version with old content)
restore(path: string, version: number): Promise<void>

// Explicit commit point (when autocommit is false)
commit(fd: number, message?: string): Promise<number>
```

### Version Creation Flow

```
open('/config.json', { write: true })
    │
    ▼
write(fd, data)  ──► buffer to temp blob
    │
    ▼
close(fd)
    │
    ├── file.versioned && dirty?
    │       │
    │       ▼
    │   1. Finalize blob in BlobStore (new UUID)
    │   2. INSERT INTO file_versions (file_id, version, data, ...)
    │   3. UPDATE file SET version = version + 1, data = new_blob_id
    │
    └── not versioned
            │
            ▼
        Overwrite existing blob (current behavior)
```

### EMS Observer Integration

```typescript
// Ring 5 observer for version creation
class VersioningObserver extends BaseObserver {
    readonly ring = ObserverRing.SQL;
    readonly operations = ['update'];
    readonly models = ['file'];

    async observe(ctx: ObserverContext): Promise<ObserverResult> {
        const record = ctx.record;
        const model = ctx.model;

        // Check if versioned and data changed
        if (!record.get('versioned')) return 'continue';
        if (!record.hasChanged('data')) return 'continue';

        // Create version entry
        const version = (record.get('version') as number) + 1;
        await ctx.system.db.execute(
            `INSERT INTO file_versions (file_id, version, data, size, author)
             VALUES (?, ?, ?, ?, ?)`,
            [record.get('id'), version, record.get('data'), record.get('size'), ctx.caller]
        );

        record.set('version', version);
        return 'continue';
    }
}
```

---

## Implementation Phases

### Phase 0: BlobStore (Prerequisite)

See OS_STORAGE_V2.md - BlobStore must be implemented first.

### Phase 1: Schema & Basic Versioning

1. Add `file_versions` table to schema.sql
2. Add `versioned`, `version` columns to file table
3. Implement VersioningObserver (Ring 5)
4. Add `versions()` syscall/API

### Phase 2: Diff Support

1. Implement Myers diff algorithm (or use library)
2. Add binary detection
3. Add `diff()` syscall/API

### Phase 3: Restore & Manual Commit

1. Add `restore()` - creates new version with old content
2. Add `commit()` syscall for explicit version creation
3. Add `autocommit` option to `open()`

### Phase 4: Retention & GC

1. Add retention policy fields
2. Extend GC to handle versioned blobs
3. Policy application observer

---

## Open Questions

1. **Checksum algorithm** - SHA-256? BLAKE3?
2. **Compression** - Compress blobs? Leave to filesystem?
3. **Delta storage** - Store binary deltas? Adds complexity.
4. **Max versions** - Default limit? Per-file configurable?
5. **Large file streaming** - How to handle multi-GB files?

---

## References

- `OS_STORAGE_V2.md` - BlobStore design (not implemented)
- `src/ems/schema.sql` - Current schema with `tracked` table pattern
- `src/ems/observers/` - Observer pipeline for hooking mutations
