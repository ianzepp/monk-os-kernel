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

### Phase 2: Schema
**Goal:** SQLite schema for models/fields tables

- [ ] Create `models` table with behavioral flags
- [ ] Create `fields` table with all constraint columns
- [ ] Create `tracked` table for audit history
- [ ] Seed system models (file, folder, device, proc, link)
- [ ] Define system fields for each model type

**Deliverable:** Can store model/field definitions in SQLite

See: [02-schema.md](./02-schema.md)

### Phase 3: Database Layer
**Goal:** High-level database service with observer pipeline

- [ ] `Model` class wrapping model metadata
- [ ] `ModelRecord` for change tracking (old vs new values)
- [ ] `ModelCache` for model/field lookup
- [ ] `DatabaseService` with CRUD + observer execution

**Deliverable:** Can CRUD entity records with observer enforcement

See: [03-database-layer.md](./03-database-layer.md)

### Phase 4: Core Observers
**Goal:** Essential behavioral observers

- [ ] Ring 0: UpdateMerger (merge input with existing)
- [ ] Ring 1: FrozenValidator, ImmutableValidator, DataValidator
- [ ] Ring 4: TransformProcessor (lowercase, trim, etc.)
- [ ] Ring 5: SqlCreate, SqlUpdate, SqlDelete
- [ ] Ring 6: ModelDdlCreate, FieldDdlCreate (schema evolution)
- [ ] Ring 7: Tracked (change history)
- [ ] Ring 8: CacheInvalidator

**Deliverable:** Full behavioral enforcement on entity mutations

See: [04-observers.md](./04-observers.md)

### Phase 5: Model Loader
**Goal:** Load YAML/JSON model definitions

- [ ] YAML/JSON parser for model definitions
- [ ] Validation of model/field definitions
- [ ] Boot-time loading of system models
- [ ] Loading user models from `/app/models/`

**Deliverable:** Can define models in YAML, load at boot

See: [05-model-loader.md](./05-model-loader.md)

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

### Phase 7: Query API (Optional)
**Goal:** Rich query interface beyond path access

- [ ] Filter class for query building
- [ ] Expose query via syscall or special path
- [ ] Support aggregations (count, sum, etc.)

See: [07-query-api.md](./07-query-api.md)

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
├── schema.sql           # models/fields/tracked tables (Phase 2)
├── model.ts             # Model class (Phase 3)
├── model-record.ts      # Change tracking (Phase 3)
├── model-cache.ts       # Caching (Phase 3)
├── database.ts          # DatabaseService (Phase 3)
└── loader/              # YAML/JSON loading (Phase 5)
```
