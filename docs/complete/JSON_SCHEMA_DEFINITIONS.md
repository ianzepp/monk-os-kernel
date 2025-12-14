# JSON Schema Definitions

## Overview

Subsystems define their EMS models, fields, and seed data using JSON files instead of SQL. This makes schema definitions dialect-agnostic - the EMS observer pipeline handles SQL generation for SQLite or PostgreSQL automatically.

The EMS bootstrap schema is dialect-specific because it creates the foundational `models`, `fields`, and `entities` tables that everything else depends on:
- `src/ems/schema.sqlite.sql` - SQLite variant with PRAGMA statements and randomblob() UUID generation
- `src/ems/schema.pg.sql` - PostgreSQL variant with native BOOLEAN types and gen_random_uuid()
- The correct schema is automatically loaded based on the database dialect detected from the connection channel protocol

## Directory Structure

Each subsystem that defines EMS models uses this structure:

```
src/{subsystem}/
  models/                    # Model definitions
    {model_name}.json
  fields/                    # Field definitions
    {model_name}.{field_name}.json
  seeds/                     # Seed data (optional)
    {NN}-{description}.json  # Number prefix for ordering
```

### Example: VFS Subsystem

```
src/vfs/
  models/
    file.json
    folder.json
    device.json
    proc.json
    link.json
    temp.json
  fields/
    file.owner.json
    file.data.json
    file.size.json
    file.mimetype.json
    file.checksum.json
    folder.owner.json
    device.owner.json
    device.driver.json
    proc.owner.json
    proc.handler.json
    link.owner.json
    link.target.json
    temp.owner.json
    temp.size.json
    temp.mimetype.json
  seeds/
    00-root-folder.json
```

## File Formats

### Model Definition (`models/{model_name}.json`)

Maps directly to a row in the `models` table:

```json
{
  "model_name": "file",
  "status": "system",
  "description": "Regular file entity - has associated blob data",
  "pathname": "name",
  "sudo": 0,
  "frozen": 0,
  "immutable": 0,
  "external": 0,
  "passthrough": 0
}
```

**Required fields:**
- `model_name` - Unique identifier, must match filename

**Optional fields:**
- `status` - "active" (default), "disabled", or "system"
- `description` - Human-readable description
- `pathname` - Field that becomes VFS path component (null = not VFS-addressable)
- `sudo`, `frozen`, `immutable`, `external`, `passthrough` - Behavioral flags (default 0)

### Field Definition (`fields/{model_name}.{field_name}.json`)

Maps directly to a row in the `fields` table:

```json
{
  "model_name": "file",
  "field_name": "owner",
  "type": "uuid",
  "required": true,
  "description": "Owner user or process ID"
}
```

**Required fields:**
- `model_name` - Parent model (must match filename prefix)
- `field_name` - Field name (must match filename suffix)
- `type` - Data type: text, integer, numeric, boolean, uuid, timestamp, date, jsonb, binary

**Optional fields:**
- `required` - Field required on create (boolean)
- `default_value` - Default if not provided
- `description` - Human-readable description
- `is_array` - Field holds array (boolean)
- `minimum`, `maximum` - Numeric range validation
- `pattern` - Regex for text validation
- `enum_values` - JSON array of allowed values
- `relationship_type` - "owned" or "referenced"
- `related_model`, `related_field`, `relationship_name` - Relationship config
- `cascade_delete`, `required_relationship` - Relationship behavior
- `immutable`, `sudo` - Field-level flags
- `indexed` - "simple" or "unique"
- `tracked` - Record changes in audit log (0 or 1)
- `searchable` - Include in full-text search (0 or 1)
- `transform` - Auto-transform: "lowercase", "trim", "uppercase"

### Seed Data (`seeds/{NN}-{description}.json`)

Contains data to insert after models/fields are created:

**Single record:**
```json
{
  "model": "folder",
  "data": {
    "id": "00000000-0000-0000-0000-000000000000",
    "owner": "system"
  }
}
```

**Multiple records:**
```json
[
  {
    "model": "device",
    "data": { "name": "console", "owner": "system", "driver": "hal:console" }
  },
  {
    "model": "device",
    "data": { "name": "null", "owner": "system", "driver": "hal:null" }
  }
]
```

**Seed fields:**
- `model` - Target model name
- `data` - Entity data (can include `id` for well-known UUIDs)

**Ordering:**
- Files are processed in sorted order (use `00-`, `10-`, `20-` prefixes)
- Earlier seeds can be referenced by later ones (e.g., root folder before child folders)

## Load Sequence

```
1. EMS bootstrap (schema.sqlite.sql or schema.pg.sql)
   └── Creates: entities, models, fields tables
   └── Seeds: models/fields meta-model definitions

2. Subsystem schema load (e.g., VFS.init())
   └── Process models/*.json → ems:upsert('models', ...)
       └── DdlCreateModel observer creates detail table
   └── Process fields/*.json → ems:upsert('fields', ...)
       └── DdlCreateField observer adds columns
   └── Process seeds/*.json (sorted) → ems:upsert(model, ...)
```

## Loader Implementation

The schema loader is a shared utility:

```typescript
// src/ems/schema-loader.ts

export async function* loadSchema(
    basePath: string,
    ems: { upsert: (model: string, data: object) => AsyncIterable<Response> }
): AsyncIterable<Response> {
    // 1. Load models (triggers DdlCreateModel)
    const modelFiles = await glob(`${basePath}/models/*.json`);
    modelFiles.sort();

    for (const file of modelFiles) {
        const model = JSON.parse(await readFile(file));
        yield* ems.upsert('models', model);
    }

    // 2. Load fields (triggers DdlCreateField)
    const fieldFiles = await glob(`${basePath}/fields/*.json`);
    fieldFiles.sort();

    for (const file of fieldFiles) {
        const field = JSON.parse(await readFile(file));
        yield* ems.upsert('fields', field);
    }

    // 3. Load seeds (sorted by filename)
    const seedFiles = await glob(`${basePath}/seeds/*.json`);
    seedFiles.sort();

    for (const file of seedFiles) {
        const content = JSON.parse(await readFile(file));
        const seeds = Array.isArray(content) ? content : [content];

        for (const seed of seeds) {
            yield* ems.upsert(seed.model, seed.data);
        }
    }
}
```

## Migration Plan

### Phase 1: VFS ✅ Complete
- Created `src/vfs/models/*.json` (6 files)
- Created `src/vfs/fields/*.json` (15 files)
- Created `src/vfs/seeds/*.json` (root folder)
- Updated `VFS.init()` to use loader
- Renamed `src/vfs/schema.sql` → `schema.sql.orig`

### Phase 2: Auth ✅ Complete
- Created `src/auth/models/*.json` (2 files: auth_user, auth_session)
- Created `src/auth/fields/*.json` (7 files)
- No seeds (root user created in code)
- Updated `Auth.loadSchema()` to use loader
- Renamed `src/auth/schema.sql` → `schema.sql.orig`

### Phase 3: LLM ✅ Complete
- Created `src/llm/models/*.json` (2 files: llm.provider, llm.model)
- Created `src/llm/fields/*.json` (21 files)
- Created `src/llm/seeds/*.json` (default providers and models)
- Updated `LLM.init()` to use loader
- Renamed `src/llm/schema.sql` → `schema.sql.orig`

### Phase 4: Audit ✅ Complete
- Created `src/audit/models/*.json` (1 file: tracked)
- Created `src/audit/fields/*.json` (8 files)
- No seeds
- Updated `Audit.init()` to use loader
- Renamed `src/audit/schema.sql` → `schema.sql.orig`

### Phase 5: EMS Dialect Split ✅ Complete
- Created `src/ems/schema.sqlite.sql` - SQLite-specific DDL with PRAGMA and randomblob() UUID
- Created `src/ems/schema.pg.sql` - PostgreSQL-specific DDL with uuid-ossp and native BOOLEAN
- Updated `src/ems/database.ts` to load dialect-specific schema based on connection.dialect
- Deleted `src/ems/schema.sql` (migrated to dialect-specific variants)
- Updated test helpers to pass dialect parameter to getSchema()
- All 2046+ tests pass with dialect-agnostic schemas

## Implementation Notes

### Natural Key Upsert
The schema loader uses natural keys for idempotent loading:
- Models: `{ key: 'model_name' }`
- Fields: `{ key: ['model_name', 'field_name'] }`

This was added to `EntityOps.upsertAll()` to handle unique constraint violations gracefully.

### Table Name Conversion
Model names with dots (e.g., `llm.provider`) are converted to underscores for table names (`llm_provider`). This is handled by `dialect.tableName()` which is used by:
- Ring 5 SQL observers (create, update, delete)
- Filter class (SELECT queries)
- Hard delete operations in DatabaseOps/EntityOps

### Field Data Normalization
The schema loader normalizes field data before insertion:
- Arrays in `enum_values` are JSON-stringified (SQLite stores as TEXT)

## Benefits

1. **Dialect-agnostic** - JSON definitions work with any database backend
2. **Single source of truth** - No duplication between SQL files
3. **Validates through EMS** - Field definitions go through observer pipeline
4. **Git-friendly** - One file per model/field, clean diffs
5. **Consistent** - Same pattern for system and user-defined models
6. **Self-documenting** - File names indicate content

## Notes

- The `entities` table remains in EMS bootstrap SQL because it's infrastructure, not a model
- System fields (id, created_at, updated_at, trashed_at, expired_at) are added automatically by DdlCreateModel
- Models using dot notation (e.g., `llm.provider`) create tables with underscores (`llm_provider`)
