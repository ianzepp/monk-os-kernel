# API Migration: Model/Field System

This document outlines the migration of the monk-api's data-driven model/field system into monk-os, enabling downstream developers to define models as YAML/JSON and have them become first-class database-backed entities accessible through the VFS.

## Vision

**Before:** Hardcoded TypeScript models (FileModel, FolderModel, etc.) with JSON blobs in key-value storage.

**After:** Dynamic, user-defined models loaded from YAML/JSON definitions, backed by real SQLite tables with full queryability, validation, and behavioral enforcement.

```yaml
# /app/models/invoice.yaml
name: invoice
fields:
  - name: number
    type: text
    required: true
    unique: true
    immutable: true
  - name: customer_id
    type: uuid
    relationship_type: referenced
    related_model: customer
  - name: total
    type: numeric
    minimum: 0
  - name: status
    type: text
    enum_values: [draft, sent, paid]
    tracked: true
```

Results in:
- SQLite table `invoice` with proper columns and constraints
- Full CRUD via VFS: `/data/invoices/`, `/data/invoices/{id}`
- Validation, immutability, change tracking enforced automatically
- Queryable: `SELECT * FROM invoice WHERE status = 'paid' AND total > 1000`

## Architecture Mapping

| monk-api Component | monk-os Target | Purpose |
|--------------------|----------------|---------|
| `models` table | `src/db/schema.sql` | Model metadata storage |
| `fields` table | `src/db/schema.sql` | Field metadata storage |
| Observer infrastructure | `src/db/observers/` | Ring-based pipeline |
| Database service | `src/db/database.ts` | CRUD with observer execution |
| Filter/query system | `src/db/filter.ts` | SQL query building |
| Describe API | `src/db/describe.ts` | Model/field management |
| DDL observers | `src/db/observers/ddl/` | Schema evolution |

## Migration Phases

### Phase 1: Foundation
**Goal:** Observer infrastructure and base classes

- [ ] Port observer interfaces and types (`ObserverContext`, `ObserverRing`, etc.)
- [ ] Port `BaseObserver` class with error handling
- [ ] Port `ObserverRunner` for ring execution
- [ ] Port observer error types (`ValidationError`, `SecurityError`, etc.)
- [ ] Create observer registry pattern

**Deliverable:** Can define and execute observers in rings 0-9

See: [01-foundation.md](./01-foundation.md)

### Phase 2: Schema
**Goal:** SQLite schema for models/fields tables

- [ ] Create `models` table with behavioral flags
- [ ] Create `fields` table with all constraint columns
- [ ] Create system field definitions
- [ ] Define seed data for system models
- [ ] Integrate with existing StorageEngine or replace

**Deliverable:** Can store model/field definitions in SQLite

See: [02-schema.md](./02-schema.md)

### Phase 3: Database Layer
**Goal:** High-level database service with observer pipeline

- [ ] Port `Database` service class
- [ ] Port select operations (selectOne, selectAny, etc.)
- [ ] Port mutate operations (createOne, updateOne, etc.)
- [ ] Port `ModelRecord` for change tracking
- [ ] Integrate observer pipeline with mutations

**Deliverable:** Can CRUD records with observer enforcement

See: [03-database-layer.md](./03-database-layer.md)

### Phase 4: Core Observers
**Goal:** Essential behavioral observers

- [ ] Ring 0: UpdateMerger (merge input with existing)
- [ ] Ring 1: DataValidator (type, required, constraints)
- [ ] Ring 1: ImmutableValidator (prevent field changes)
- [ ] Ring 1: FrozenValidator (prevent model changes)
- [ ] Ring 5: SQL observers for SQLite (create, update, delete)
- [ ] Ring 6: DDL observers (CREATE TABLE, ALTER TABLE)
- [ ] Ring 7: Tracked observer (change history)
- [ ] Ring 8: Cache invalidation

**Deliverable:** Full behavioral enforcement on mutations

See: [04-observers.md](./04-observers.md)

### Phase 5: Model Loader
**Goal:** Load YAML/JSON model definitions

- [ ] YAML/JSON parser for model definitions
- [ ] Validation of model/field definitions
- [ ] Conversion to models/fields table records
- [ ] Boot-time loading from `/etc/models/` or config
- [ ] Hot-reload support (optional)

**Deliverable:** Can define models in YAML, load at boot

See: [05-model-loader.md](./05-model-loader.md)

### Phase 6: VFS Integration
**Goal:** VFS becomes path interface to models

- [ ] Replace/refactor FileModel to use database layer
- [ ] Map paths to model records: `/data/{model}/{id}`
- [ ] Implement list/stat/read/write via Database service
- [ ] Preserve existing device/proc models
- [ ] Handle relationships via path traversal

**Deliverable:** Files ARE database rows, accessible via VFS

See: [06-vfs-integration.md](./06-vfs-integration.md)

### Phase 7: Query API (Optional)
**Goal:** Rich query interface beyond path access

- [ ] Port Filter class for query building
- [ ] Expose query via special path or syscall
- [ ] Support aggregations (count, sum, etc.)
- [ ] Relationship traversal in queries

**Deliverable:** Can query models with SQL-like semantics

See: [07-query-api.md](./07-query-api.md)

## Component Inventory

### From monk-api (to port)

```
src/lib/observers/           → src/db/observers/
  interfaces.ts                 Core observer contracts
  types.ts                      Ring system, operation types
  errors.ts                     ValidationError, SecurityError, etc.
  base-observer.ts              Abstract base class
  runner.ts                     Ring execution engine
  loader.ts                     Observer registry/loading

src/observers/               → src/db/observers/impl/
  all/0/50-update-merger.ts     Data preparation
  all/1/40-data-validator.ts    Type/constraint validation
  all/1/30-immutable-validator  Immutable field enforcement
  all/1/10-frozen-validator     Frozen model enforcement
  all/5/50-sql-*-sqlite.ts      SQLite CRUD operations
  fields/6/10-field-ddl-*       ALTER TABLE operations
  models/6/10-model-ddl-*       CREATE/DROP TABLE
  all/7/60-tracked.ts           Change tracking

src/lib/database/            → src/db/
  service.ts                    Database class
  select.ts                     Read operations
  mutate.ts                     Write operations
  pipeline.ts                   Observer execution
  types.ts                      TypeScript interfaces

src/lib/
  model.ts                   → src/db/model.ts
  field.ts                   → src/db/field.ts
  model-record.ts            → src/db/model-record.ts
  describe.ts                → src/db/describe.ts
  describe-models.ts         → src/db/describe-models.ts
  describe-fields.ts         → src/db/describe-fields.ts
  filter.ts                  → src/db/filter.ts
  filter-types.ts            → src/db/filter-types.ts
  filter-where-sqlite.ts     → src/db/filter-where.ts

src/lib/sql/
  tenant.sqlite.sql          → src/db/schema.sql
```

### In monk-os (to modify)

```
src/hal/storage/sqlite.ts    May need enhancement for relational ops
src/vfs/model.ts             Refactor to delegate to Database service
src/vfs/models/file.ts       Simplify to thin wrapper
src/vfs/vfs.ts               Add /data mount for model access
src/kernel/boot.ts           Add model loading step
```

## Key Decisions

### 1. Storage Engine Evolution

**Option A:** Enhance existing `StorageEngine` with SQL capabilities
- Pros: Minimal disruption, gradual migration
- Cons: Awkward API mixing KV and relational

**Option B:** New `DatabaseEngine` alongside `StorageEngine`
- Pros: Clean separation, purpose-built API
- Cons: Two storage systems to manage

**Option C:** Replace `StorageEngine` with relational-first design
- Pros: Unified model, full SQL power
- Cons: Breaking change, migration effort

**Recommendation:** Option B initially, migrate to C over time.

### 2. System Models

How to handle existing FileModel, FolderModel, etc.?

**Option A:** Convert to model definitions in database
- Pros: Unified, consistent
- Cons: Bootstrap complexity (need models to load models)

**Option B:** Keep as hardcoded "system" models
- Pros: Simple bootstrap, always available
- Cons: Two model systems

**Recommendation:** Option B with system models seeded at boot, marked as `status: 'system'`.

### 3. VFS Path Mapping

How do model records appear in the filesystem?

```
/data/                       Root for all user models
/data/{model}/               List records
/data/{model}/{id}           Record as file (JSON content)
/data/{model}/{id}/{field}   Field value (for relationships)

/sys/models/                 Model definitions (read-only?)
/sys/fields/                 Field definitions
```

### 4. Multi-tenancy

monk-api uses PostgreSQL schemas for tenant isolation. In monk-os:

**Option A:** Separate SQLite files per tenant
**Option B:** Single SQLite with tenant_id column
**Option C:** No multi-tenancy (single-tenant OS)

**Recommendation:** Option C for initial implementation. Add tenancy later if needed.

## Success Criteria

1. **Model Definition:** Can define a model in YAML and have it create a table
2. **CRUD Operations:** Can create, read, update, delete records via VFS paths
3. **Validation:** Invalid data is rejected based on field constraints
4. **Immutability:** Immutable fields cannot be changed after creation
5. **Relationships:** Can traverse relationships via paths
6. **Change Tracking:** Tracked fields record history
7. **Queryability:** Can query beyond simple path access
8. **Performance:** Observer overhead is acceptable (<10ms per operation)

## Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| 1. Foundation | 2-3 days | None |
| 2. Schema | 1 day | Phase 1 |
| 3. Database Layer | 3-4 days | Phase 2 |
| 4. Core Observers | 3-4 days | Phase 3 |
| 5. Model Loader | 2 days | Phase 4 |
| 6. VFS Integration | 3-4 days | Phase 5 |
| 7. Query API | 2-3 days | Phase 6 (optional) |

**Total:** ~2-3 weeks for core functionality

## Next Steps

1. Review this plan and confirm architectural decisions
2. Start with Phase 1: Foundation
3. Create test harness for observer pipeline
4. Iterate through phases with tests at each step
