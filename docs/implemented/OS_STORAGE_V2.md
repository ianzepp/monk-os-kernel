# Storage Engine V2: Unified Entity & Blob Architecture

> **Status**: Largely Implemented (EMS)
> **Created**: December 2024
> **Goal**: Realize the "every file is both a database and a row" vision

---

## Implementation Status

The Entity Model System (EMS) at `src/ems/` implements most of this design with significant enhancements:

| Planned Component | Status | Implementation |
|------------------|--------|----------------|
| StorageEngine V2 | ✅ Implemented | `EntityOps`, `DatabaseOps`, `DatabaseConnection` |
| Entity Table | ✅ Implemented | `entities` table + per-model detail tables |
| Query Interface | ✅ Implemented | `Filter` system with `selectAny()` |
| Observer Pipeline | ✅ Enhanced | Ring-based observers (not in original plan) |
| Model Metadata | ✅ Enhanced | `models` + `fields` tables (not in original plan) |
| Change Tracking | ✅ Enhanced | `tracked` table (not in original plan) |
| BlobStore | ❌ Not Implemented | Referenced in schema but no BlobStore class |

---

## 1. What Was Implemented

### EMS Architecture

```
┌─────────────────────────────────────┐
│  EntityAPI (os.ems)                 │  ← Public: array-based
├─────────────────────────────────────┤
│  EntityOps                          │  ← Kernel: streaming + observers
├─────────────────────────────────────┤
│  DatabaseOps                        │  ← Kernel: generic SQL streaming
├─────────────────────────────────────┤
│  DatabaseConnection                 │  ← HAL: channel wrapper
└─────────────────────────────────────┘
```

Key files:
- `src/ems/entity-ops.ts` - Entity CRUD with observer pipeline
- `src/ems/database-ops.ts` - Generic SQL streaming
- `src/ems/connection.ts` - HAL-based SQLite connection
- `src/ems/filter.ts` - Query builder
- `src/ems/schema.sql` - Full schema with seed data

### Schema Design (Differs from Plan)

The original plan had a single `entities` table with all fields. EMS uses a **split-table design**:

```sql
-- Core identity + hierarchy (minimal for cache efficiency)
entities (id, model, parent, pathname)

-- Per-model detail tables (FK to entities)
file (id, owner, data, size, mimetype, checksum)
folder (id, owner)
device (id, owner, driver)
proc (id, owner, handler)
link (id, owner, target)
temp (id, owner, size, mimetype)
```

**Why the difference**: EntityCache loads all entities into memory. Keeping `entities` minimal (4 columns) reduces memory footprint. Timestamps and model-specific fields live in detail tables.

### Meta-Model System (Enhancement)

EMS adds a meta-model system not in the original plan:

```sql
-- Model definitions
models (model_name, status, sudo, frozen, immutable, external, passthrough, pathname)

-- Field definitions per model
fields (model_name, field_name, type, required, default_value, ...)

-- Change history for tracked fields
tracked (model_name, record_id, operation, changes, ...)
```

This enables:
- Runtime schema introspection
- Field-level validation/constraints
- Model-level behavioral flags
- Change auditing

### Observer Pipeline (Enhancement)

EMS includes a Ring-based observer pipeline (not in original plan):

| Ring | Purpose |
|------|---------|
| 0 | Update Merger - Apply changes to record |
| 1 | Validation - Frozen, immutable, constraints |
| 4 | Transform - Field transforms (lowercase, trim) |
| 5 | SQL - Execute INSERT/UPDATE/DELETE |
| 6 | DDL - Create model tables dynamically |
| 7 | Tracked - Change history recording |
| 8 | Cache - Entity cache synchronization |

---

## 2. What Was NOT Implemented

### BlobStore

The original plan specified a `BlobStore` for message-oriented content streaming:

```typescript
// PLANNED - NOT IMPLEMENTED
interface BlobStore {
    read(id: string, opts?: ReadOptions): AsyncIterable<Response>;
    write(id: string, chunks: AsyncIterable<Response>): Promise<number>;
    writeBytes(id: string, data: Uint8Array): Promise<void>;
    append(id: string, data: Uint8Array): Promise<void>;
    truncate(id: string, size: number): Promise<void>;
    stat(id: string): Promise<BlobStat | null>;
    exists(id: string): Promise<boolean>;
    delete(id: string): Promise<void>;
}
```

**Current state**: The `file` table has a `data` column referencing "blob in HAL block storage", but no BlobStore implementation exists. File content handling is done elsewhere (VFS layer).

### Streaming File Handle

The original plan specified `StreamingFileHandle` for zero-copy file reads:

```typescript
// PLANNED - NOT IMPLEMENTED
class StreamingFileHandle implements FileHandle {
    async *read(size?: number): AsyncIterable<Response> {
        yield* this.ctx.hal.blobs.read(this.entity.blob!, { ... });
    }
}
```

**Current state**: File handles may still buffer content. The VFS layer handles files independently.

---

## 3. Original Problem Statement (For Reference)

### Problems Solved by EMS

1. **Full table scans** → Solved: `Filter` system generates indexed SQL queries
2. **No query capability** → Solved: `selectAny()` with WHERE, ORDER BY, LIMIT
3. **JSON encode/decode overhead** → Solved: Native SQL columns, not JSON blobs

### Problems NOT Fully Solved

4. **In-memory blob loading** → Partial: Schema references HAL block storage, but no streaming implementation
5. **Bytes vs messages inconsistency** → Partial: EMS is message-based, but blob I/O not addressed

---

## 4. Future Work

### BlobStore Implementation

If blob streaming is needed:

```typescript
// Proposed location: src/hal/blob.ts
class FilesystemBlobStore implements BlobStore {
    constructor(private dataDir: string) {}

    private pathFor(id: string): string {
        // aa/aabbccdd-... layout
        const prefix = id.substring(0, 2);
        return path.join(this.dataDir, prefix, id);
    }

    async *read(id: string, opts?: ReadOptions): AsyncIterable<Response> {
        // Stream from file, yield respond.chunk() messages
    }
}
```

### HAL Integration

```typescript
interface HAL {
    // Existing
    storage: StorageEngine;  // ← Now backed by EMS

    // Future
    blobs: BlobStore;        // ← Content streaming (not implemented)
}
```

---

## 5. Open Questions (Updated)

1. ~~**Entity table design**~~ → Resolved: Split entities + detail tables
2. ~~**Query capability**~~ → Resolved: Filter system
3. ~~**Observer pipeline**~~ → Resolved: Ring-based observers
4. **Blob garbage collection** → Still open: When entity deleted, when to delete blob?
5. **Atomic operations** → Partially addressed: SQLite transactions, but entity+blob not atomic
6. **Large file handling** → Still open: No streaming blob implementation
7. **Cache layer** → Resolved: EntityCache for entities, but no blob cache

---

## 6. References

- `src/ems/` - Entity Model System implementation
- `src/ems/schema.sql` - Database schema
- `src/ems/entity-ops.ts` - Entity CRUD operations
- `src/ems/database-ops.ts` - Generic SQL streaming
- `src/ems/filter.ts` - Query builder
- `src/ems/observers/` - Ring-based observer pipeline
