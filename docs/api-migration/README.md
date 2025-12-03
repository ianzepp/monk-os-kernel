# API Migration: Model/Field System

This document outlines the migration of the monk-api's data-driven model/field system into monk-os, enabling downstream developers to define models as YAML/JSON and have them become first-class database-backed entities accessible through the VFS.

## Core Architecture: Entity + Data

**Every VFS entry has two components:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  VFS Entry: /vol/documents/report.pdf                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ENTITY (SQL)                         DATA (Blob)                   │
│  ┌───────────────────────────┐       ┌───────────────────────────┐  │
│  │ id: "abc-123"             │       │                           │  │
│  │ model: "file"             │       │  %PDF-1.4...              │  │
│  │ name: "report.pdf"        │       │  (raw bytes)              │  │
│  │ parent: "folder-xyz"      │       │                           │  │
│  │ owner: "user-456"         │       │  No schema.               │  │
│  │ size: 24853               │       │  No validation.           │  │
│  │ mtime: 2024-12-03         │       │  Direct I/O.              │  │
│  │ mimetype: "application/…" │       │                           │  │
│  │ custom_field: "value"     │       │                           │  │
│  └───────────────────────────┘       └───────────────────────────┘  │
│           │                                   │                     │
│           ▼                                   ▼                     │
│    stat() / setstat()                  read() / write()             │
│           │                                   │                     │
│    Observer Pipeline                    HAL Block I/O               │
│    (validation, audit, etc.)           (no observers)               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Entity = Structured Metadata (SQL)**
   - Stored in SQLite with schema defined by `models` and `fields` tables
   - Shape determined by model type (file, folder, device, invoice, etc.)
   - Accessed via `stat()`, mutated via `setstat()`
   - **All mutations go through the observer pipeline**

2. **Data = Raw Bytes (Blob)**
   - Stored via HAL block storage
   - No schema, no validation
   - Accessed via `read()`, mutated via `write()`
   - **Bypasses observer pipeline entirely**

3. **Universal Application**
   - This applies to ALL VFS entries, not just user-defined models
   - System models (file, folder, device, proc) have entities too
   - The observer pipeline enforces validation/audit for everything

### Operation Routing

| Operation | Target | Observer Pipeline? | Purpose |
|-----------|--------|-------------------|---------|
| `stat()` | Entity | No (read-only) | Get metadata |
| `setstat()` | Entity | **Yes** | Update metadata |
| `create()` | Entity | **Yes** | Create new entry |
| `unlink()` | Entity | **Yes** | Soft-delete entry |
| `read()` | Data | No | Get raw bytes |
| `write()` | Data | No | Set raw bytes |

### Example: Creating a File

```typescript
// 1. Create entity (goes through observers)
await vfs.create('/vol/docs', 'report.pdf', {
    mimetype: 'application/pdf',
    owner: currentUser,
});
// → Ring 1: Validate required fields
// → Ring 5: INSERT INTO file (...)
// → Ring 7: Audit log

// 2. Write data (direct I/O, no observers)
await vfs.write('/vol/docs/report.pdf', pdfBytes);
// → HAL.block.write() directly
```

### Example: Updating Metadata

```typescript
// Change owner (goes through observers)
await vfs.setstat('/vol/docs/report.pdf', { owner: 'new-owner' });
// → Ring 1: Validate owner exists
// → Ring 2: Check permissions
// → Ring 5: UPDATE file SET owner = ?
// → Ring 7: Audit the change
```

## Models Define Entity Shape

The `models` and `fields` tables define what fields exist on each entity type:

```yaml
# System model (seeded at boot)
name: file
status: system
fields:
  - name: mimetype
    type: text
  - name: size
    type: integer
  - name: checksum
    type: text

# User-defined model (loaded from YAML)
name: invoice
fields:
  - name: number
    type: text
    required: true
    immutable: true
  - name: total
    type: numeric
    minimum: 0
  - name: status
    type: text
    enum: [draft, sent, paid]
    tracked: true
```

Both system and user models:
- Have their entity stored in SQL
- Have mutations validated by observers
- Can have custom fields, constraints, and behaviors

## Vision

**Before:** Hardcoded TypeScript models with JSON blobs in key-value storage.

**After:** Dynamic, schema-driven models where:
- Entity metadata is stored in SQLite with full queryability
- All entity mutations flow through the observer pipeline
- User-defined models work identically to system models
- Blob data remains separate, accessed via standard POSIX I/O

## Migration Phases

### Phase 1: Foundation (IMPLEMENTED)
**Goal:** Observer infrastructure and base classes

- [x] Observer interfaces and types (`ObserverContext`, `ObserverRing`, etc.)
- [x] `BaseObserver` class with timeout handling
- [x] `ObserverRunner` for ring execution
- [x] Observer error types (`EOBSINVALID`, `EOBSSEC`, etc.)
- [x] Observer registry pattern

**Location:** `src/model/observers/`

See: [01-foundation.md](./01-foundation.md)

### Phase 2: Schema (IMPLEMENTED)
**Goal:** SQLite schema for models/fields tables

- [x] Create `models` table with behavioral flags
- [x] Create `fields` table with all constraint columns
- [x] Create `tracked` table for audit history
- [x] Seed system models (file, folder, device, proc, link)
- [x] Define system fields for each model type
- [x] HAL FileDevice for kernel-level filesystem access
- [x] HAL SQLite channel `exec` operation for multi-statement SQL
- [x] DatabaseConnection class with HAL-based SQLite access

**Location:** `src/model/schema.sql`, `src/model/connection.ts`, `src/hal/file.ts`

See: [02-schema.md](./02-schema.md)

### Phase 3: Database Layer (IMPLEMENTED)
**Goal:** High-level database service with observer pipeline

- [x] `Model` class wrapping model metadata with field categorization
- [x] `ModelRecord` for change tracking (old vs new values, diff generation)
- [x] `ModelCache` for async model/field lookup with request deduplication
- [x] `DatabaseService` with CRUD + observer execution
- [x] System entity tables (file, folder, device, proc, link) in schema.sql

**Location:** `src/model/model.ts`, `src/model/model-record.ts`, `src/model/model-cache.ts`, `src/model/database.ts`

**Note:** DatabaseService API needs revision in Phase 3.5 to align with VFS patterns.

See: [03-database-layer.md](./03-database-layer.md)

### Phase 4: Core Observers (IMPLEMENTED)
**Goal:** Essential behavioral observers

- [x] Ring 0: UpdateMerger (merge input with existing)
- [x] Ring 1: Frozen, Immutable, Constraints (validation)
- [x] Ring 4: TransformProcessor (lowercase, trim, etc.)
- [x] Ring 5: SqlCreate, SqlUpdate, SqlDelete
- [x] Ring 6: DdlCreateModel, DdlCreateField (schema evolution)
- [x] Ring 7: Tracked (change history)
- [x] Ring 8: Cache (cache invalidation)

**Deliverable:** Full behavioral enforcement on entity mutations

See: [04-observers.md](./04-observers.md)

### Phase 5: Model Loader (DEFERRED)
**Goal:** Load YAML/JSON model definitions

Deferred indefinitely. System models seeded via schema.sql; user models can be created programmatically via DatabaseOps.

See: [99-deferred.md](./99-deferred.md)

### Phase 5.5: Entity Cache
**Goal:** In-memory entity index for O(1) path resolution

- [ ] `EntityCache` class with `byId` and `childIndex` maps
- [ ] Load all entities from all model tables at boot (~300MB for 1M entities)
- [ ] Path resolution via in-memory lookups (zero SQL)
- [ ] Model dispatch via cached `model` field
- [ ] Cache sync via Ring 8 observer on create/update/delete
- [ ] Handle rename (update childIndex key)
- [ ] Handle move (update parent, reindex in both old and new parent)

**Deliverable:** Path resolution and model dispatch without database queries

See: [05.5-entity-cache.md](./05.5-entity-cache.md)

### Phase 6: VFS Integration
**Goal:** Wire VFS operations to the model layer

- [ ] `stat()` returns entity from database
- [ ] `setstat()` routes through observer pipeline
- [ ] `create()` creates entity via observers, allocates blob storage
- [ ] `unlink()` soft-deletes entity via observers
- [ ] `read()`/`write()` continue to use HAL block storage directly
- [ ] Existing FileModel, FolderModel become thin wrappers

**Deliverable:** VFS operations use entity+data architecture

See: [06-vfs-integration.md](./06-vfs-integration.md)

### Phase 7: Query API (DEFERRED)
**Goal:** Rich query interface beyond path access

Deferred indefinitely. Direct SQL queries via DatabaseConnection work for current needs.

See: [99-deferred.md](./99-deferred.md)

## Key Decisions

### 1. Entity Storage

All entity metadata stored in SQLite tables. Each model type has its own table (file, folder, invoice, etc.) with columns defined by the `fields` table.

### 2. System Models

System models (file, folder, device, proc, link) are seeded at boot with `status: 'system'`. They use the same observer pipeline as user models - no special cases.

### 3. Blob Storage

Blob data remains in HAL block storage, keyed by entity ID. The `size` field in the entity tracks blob size. Blobs are optional (folders have no blob).

### 4. Path Resolution

```
/vol/docs/report.pdf
    │
    ├─ Resolve path → entity ID "abc-123"
    │
    ├─ stat()     → SELECT * FROM file WHERE id = 'abc-123'
    ├─ setstat()  → Observer pipeline → UPDATE file ...
    ├─ read()     → HAL.block.read('abc-123')
    └─ write()    → HAL.block.write('abc-123', data)
```

## Success Criteria

1. **Unified Model:** System and user models use identical entity+data architecture
2. **Observer Enforcement:** All entity mutations go through observer pipeline
3. **Validation:** Invalid entity data rejected based on field constraints
4. **Audit:** Tracked fields record change history
5. **Blob Separation:** Raw data I/O bypasses observers for performance
6. **Queryability:** Can query entities with SQL semantics

## Directory Structure

```
src/model/
├── observers/           # Observer pipeline (Phase 1 - DONE)
│   ├── types.ts
│   ├── errors.ts
│   ├── interfaces.ts
│   ├── base-observer.ts
│   ├── runner.ts
│   ├── registry.ts
│   └── impl/            # Observer implementations (Phase 4)
├── schema.sql           # models/fields/tracked + entity tables (Phase 2/3 - DONE)
├── connection.ts        # DatabaseConnection class (Phase 2 - DONE)
├── index.ts             # Public exports (Phase 2/3 - DONE)
├── model.ts             # Model class (Phase 3 - DONE)
├── model-record.ts      # Change tracking (Phase 3 - DONE)
├── model-cache.ts       # Async caching (Phase 3 - DONE)
├── database.ts          # DatabaseService (Phase 3 - DONE, needs 3.5 revision)
└── loader/              # YAML/JSON loading (Phase 5)

src/hal/
├── file.ts              # FileDevice for kernel filesystem access (Phase 2 - DONE)
└── ...                  # Other HAL devices
```
