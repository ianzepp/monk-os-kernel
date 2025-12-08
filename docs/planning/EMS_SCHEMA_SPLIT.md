# EMS Schema Split & Subsystem DDL Registration

> **Status**: Planning
> **Affects**: EMS, VFS, connection.ts, schema.sql

Split the monolithic `src/ems/schema.sql` into per-subsystem schema files and add an EMS method
for subsystems to register their DDL during initialization.

---

## Problem Statement

### Current State

The file `src/ems/schema.sql` contains DDL for multiple subsystems:

| Content | Lines | Owner |
|---------|-------|-------|
| `entities` table | 87-123 | EMS core |
| `models` table | 136-197 | EMS core |
| `fields` table | 207-318 | EMS core |
| `tracked` table | 333-377 | EMS core |
| `file` table | 393-411 | VFS |
| `folder` table | 418-432 | VFS |
| `device` table | 439-450 | VFS |
| `proc` table | 457-468 | VFS |
| `link` table | 475-486 | VFS |
| `temp` table | 493-505 | VFS |
| Root entity seed | 513-517 | VFS |
| Meta-model seeds | 527-530 | EMS core |
| VFS model seeds | 538-544 | VFS |
| Field seeds (all) | 550-654 | Mixed |

### Issues

1. **Unclear ownership** - VFS tables live in EMS directory
2. **Coupling** - EMS must know about VFS schema at compile time
3. **Extensibility** - Adding new subsystems requires modifying `src/ems/schema.sql`
4. **Testing** - Cannot test EMS without VFS schema

### Desired State

Each subsystem owns its schema file and registers it during initialization:

```
src/ems/schema.sql    → EMS core only (entities, models, fields, tracked)
src/vfs/schema.sql    → VFS detail tables (file, folder, device, proc, link, temp)
```

Subsystems call `ems.exec()` during their init to apply their schema.

---

## Design

### New EMS Method: `exec()`

Add a method to the EMS class for executing raw SQL with optional cache management:

```typescript
// src/ems/ems.ts

interface ExecOptions {
    /** Clear entire model cache after exec (for bulk schema loads) */
    clearModels?: boolean;

    /** Invalidate specific models after exec */
    invalidate?: string[];
}

async exec(sql: string, options?: ExecOptions): Promise<void> {
    if (!this._db) {
        throw new EINVAL('EMS not initialized');
    }

    await this._db.exec(sql);

    if (options?.clearModels) {
        this._models?.clear();
    }
    else if (options?.invalidate) {
        for (const model of options.invalidate) {
            this._models?.invalidate(model);
        }
    }
}
```

### Capability-Based Security Model

Access control is implicit via object references:

| Caller | Has EMS Reference? | Can Call exec()? |
|--------|-------------------|------------------|
| Kernel init | Yes (creates EMS) | Yes |
| VFS init | Yes (receives from kernel) | Yes |
| Ring 6 DDL observers | No (has SystemContext) | No |
| External API | No | No |

Ring 6 DDL observers continue using `system.db.exec()` via SystemContext. This is intentional:
- Observers handle per-record DDL (CREATE TABLE for one model)
- `ems.exec()` handles bulk schema loading (entire subsystem)

### Schema Split

#### `src/ems/schema.sql` (EMS Core)

```sql
-- PRAGMAS
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ENTITIES TABLE (identity + hierarchy backbone)
CREATE TABLE IF NOT EXISTS entities (...);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_parent_pathname ...;
CREATE INDEX IF NOT EXISTS idx_entities_parent ...;
CREATE INDEX IF NOT EXISTS idx_entities_model ...;

-- MODELS TABLE (model definitions)
CREATE TABLE IF NOT EXISTS models (...);
CREATE INDEX IF NOT EXISTS idx_models_status ...;

-- FIELDS TABLE (field definitions)
CREATE TABLE IF NOT EXISTS fields (...);
CREATE INDEX IF NOT EXISTS idx_fields_model ...;

-- TRACKED TABLE (audit log)
CREATE TABLE IF NOT EXISTS tracked (...);
CREATE INDEX IF NOT EXISTS idx_tracked_record ...;

-- META-MODEL SEEDS (models, fields, tracked)
INSERT OR IGNORE INTO models (model_name, status, sudo, description) VALUES
    ('models', 'system', 1, 'Model definitions'),
    ('fields', 'system', 1, 'Field definitions'),
    ('tracked', 'system', 1, 'Change tracking history');

-- META-MODEL FIELD SEEDS
INSERT OR IGNORE INTO fields (model_name, field_name, type, ...) VALUES
    ('models', 'model_name', 'text', ...),
    ('models', 'status', 'text', ...),
    ...
    ('fields', 'model_name', 'text', ...),
    ('fields', 'field_name', 'text', ...),
    ...
    ('tracked', 'change_id', 'integer', ...),
    ...
```

#### `src/vfs/schema.sql` (VFS)

```sql
-- ROOT ENTITY (namespace origin)
INSERT OR IGNORE INTO entities (id, model, parent, pathname) VALUES
    ('00000000-0000-0000-0000-000000000000', 'folder', NULL, '');

-- VFS MODEL SEEDS
INSERT OR IGNORE INTO models (model_name, status, description, pathname) VALUES
    ('file', 'system', 'Regular file entity', 'name'),
    ('folder', 'system', 'Directory entity', 'name'),
    ('device', 'system', 'Device node entity', 'name'),
    ('proc', 'system', 'Process/virtual file entity', 'name'),
    ('link', 'system', 'Symbolic link entity', 'name'),
    ('temp', 'system', 'Temporary file entity', 'name');

-- FILE TABLE
CREATE TABLE IF NOT EXISTS file (...);
CREATE INDEX IF NOT EXISTS idx_file_owner ...;

-- FOLDER TABLE
CREATE TABLE IF NOT EXISTS folder (...);
CREATE INDEX IF NOT EXISTS idx_folder_owner ...;

-- DEVICE TABLE
CREATE TABLE IF NOT EXISTS device (...);

-- PROC TABLE
CREATE TABLE IF NOT EXISTS proc (...);

-- LINK TABLE
CREATE TABLE IF NOT EXISTS link (...);

-- TEMP TABLE
CREATE TABLE IF NOT EXISTS temp (...);

-- ROOT FOLDER DETAIL
INSERT OR IGNORE INTO folder (id, owner) VALUES
    ('00000000-0000-0000-0000-000000000000', 'system');

-- VFS FIELD SEEDS
INSERT OR IGNORE INTO fields (model_name, field_name, type, ...) VALUES
    ('file', 'owner', 'uuid', ...),
    ('file', 'size', 'integer', ...),
    ...
    ('folder', 'owner', 'uuid', ...),
    ...
```

### Initialization Flow

```
Kernel.init()
    │
    ├── 1. Create HAL
    │
    ├── 2. Create EMS
    │       │
    │       └── EMS.init()
    │               │
    │               ├── createDatabase() with src/ems/schema.sql
    │               ├── Create ModelCache
    │               ├── Create ObserverRunner
    │               └── Create EntityOps
    │
    ├── 3. Create VFS
    │       │
    │       └── VFS.init(ems)  ◄── receives EMS reference
    │               │
    │               ├── Load src/vfs/schema.sql via HAL
    │               ├── ems.exec(vfsSchema, { clearModels: true })
    │               └── Continue VFS initialization
    │
    └── 4. Continue kernel init...
```

### Order Dependencies

Schema loading order matters due to foreign keys:

1. **EMS core first** - `entities` table must exist before VFS detail tables (FK)
2. **models seed first** - VFS field seeds reference model names
3. **VFS tables** - Can reference `entities.id`

The split maintains this: EMS schema runs in `EMS.init()`, VFS schema runs in `VFS.init()`.

---

## Files to Change

### Must Change

| File | Change |
|------|--------|
| `src/ems/ems.ts` | Add `exec(sql, options?)` method |
| `src/ems/schema.sql` | Remove VFS tables, keep EMS core only |
| `src/vfs/schema.sql` | **New file** - VFS tables and seeds |
| `src/vfs/vfs.ts` | Load and apply VFS schema in `init()` |

### May Need Updates

| File | Reason |
|------|--------|
| `src/ems/connection.ts` | Possibly simplify `createDatabase()` |
| `src/ems/model-cache.ts` | `preloadSystemModels()` lists VFS models - may need adjustment |
| `spec/ems/*.test.ts` | Tests may assume VFS tables exist |
| `spec/vfs/*.test.ts` | May need to ensure schema is loaded |

### Reference (Similar Patterns)

| File | Pattern |
|------|---------|
| `src/ems/ring/6/10-ddl-create-model.ts` | Uses `system.db.exec(sql)` for DDL |
| `src/ems/ring/6/10-ddl-create-field.ts` | Uses `system.db.exec(sql)` for DDL |
| `src/ems/ring/8/50-cache.ts` | Uses `system.cache.invalidate()` |
| `src/ems/connection.ts:128` | `loadSchemaAsync()` pattern for reading schema files |

---

## Implementation Steps

### Step 1: Add EMS.exec() Method

```typescript
// In src/ems/ems.ts

interface ExecOptions {
    clearModels?: boolean;
    invalidate?: string[];
}

async exec(sql: string, options?: ExecOptions): Promise<void> {
    if (!this._db) {
        throw new EINVAL('EMS not initialized');
    }

    await this._db.exec(sql);

    if (options?.clearModels) {
        this._models?.clear();
    }
    else if (options?.invalidate) {
        for (const model of options.invalidate) {
            this._models?.invalidate(model);
        }
    }
}
```

### Step 2: Split schema.sql

1. Create `src/vfs/schema.sql` with VFS content
2. Remove VFS content from `src/ems/schema.sql`
3. Ensure seed data ordering is correct

### Step 3: Update VFS.init()

```typescript
// In src/vfs/vfs.ts

async init(): Promise<void> {
    // Load VFS schema
    const schemaPath = new URL('./schema.sql', import.meta.url).pathname;
    const schema = await this.hal.file.readText(schemaPath);

    // Apply schema and clear model cache
    await this.ems.exec(schema, { clearModels: true });

    // Continue existing init...
    await this.ensureRoot();
}
```

### Step 4: Update Tests

- EMS tests should work with EMS-only schema
- VFS tests should explicitly load VFS schema
- Integration tests may need both

---

## Alternatives Considered

### Alternative 1: Schema Registry

EMS maintains a list of schema file paths, loads all during init:

```typescript
const schemas = [
    './schema.sql',           // EMS core
    '../vfs/schema.sql',      // VFS
];
```

**Rejected**: Still couples EMS to other subsystems at compile time.

### Alternative 2: Event-Based Registration

Subsystems emit 'schema' events, EMS collects and applies:

```typescript
kernel.on('schema', (sql) => ems.exec(sql));
vfs.emit('schema', vfsSchema);
```

**Rejected**: Adds complexity, unclear ordering guarantees.

### Alternative 3: Keep Single File

Leave schema.sql as-is, document ownership via comments.

**Rejected**: Doesn't solve coupling or testability issues.

---

## Open Questions

1. **EntityCache refresh** - Should `exec()` also clear/reload EntityCache? Currently only handles ModelCache.

2. **Schema versioning** - Should schema files include version markers for migrations?

3. **preloadSystemModels()** - ModelCache.preloadSystemModels() hardcodes VFS model names. Should this be configurable or removed?

4. **Future subsystems** - If kernel or gateway need SQL tables, same pattern applies?

---

## References

- `src/ems/schema.sql` - Current monolithic schema
- `src/ems/connection.ts` - Schema loading mechanism
- `src/ems/ems.ts` - EMS class
- `src/vfs/vfs.ts` - VFS initialization
- `src/ems/ring/6/` - DDL observers using `system.db.exec()`
- `src/ems/ring/8/50-cache.ts` - Cache invalidation observer
