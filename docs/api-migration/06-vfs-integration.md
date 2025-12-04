# Phase 6: VFS Integration

## Prerequisites

- [Phase 5.5: Entity Cache](./05.5-entity-cache.md) - Required for O(1) path resolution and model dispatch
- [Phase 6.1: Entities Table](./06.1-entities-table.md) - Core identity + hierarchy table

## Overview

Wire VFS operations to the entity+data architecture, starting with `/tmp` as a proof-of-concept.

**Approach:** Incremental. Start simple, learn as we go.

## Architecture

The architecture uses a two-table design:

```
/tmp/foo.txt
    │
    ├── entities table ──────────────────────┐
    │   (identity + hierarchy)               │
    │   - id, model, parent, name            │
    │   - NO timestamps (cache efficiency)   │
    │                                        │
    │   EntityCache loads this table         │
    │   Path resolution happens here         │
    │                                        │
    ├── temp table (detail) ─────────────────┤
    │   - id (FK → entities.id)              │
    │   - created_at, updated_at             │
    │   - trashed_at, expired_at             │
    │   - owner, size, mimetype              │
    │                                        │
    │   stat() ──► JOIN entities + temp      │
    │   setstat() ──► Observer pipeline      │
    │                                        │
    └── Data (HAL) ──────────────────────────┘
        blob storage (keyed by entity id)

        read() ──► HAL.storage.get(id)
        write() ──► HAL.storage.put(id, data)
```

**Key principles:**
- `entities` table = UUID→model lookup + path resolution (minimal, cache-friendly)
- Detail tables = timestamps + model-specific fields
- Trashing updates detail table only (cache unchanged)
- Blob data in HAL (direct I/O)

## Data Flow

### CREATE
```
Ring 5 SqlCreate:
  1. BEGIN TRANSACTION
  2. INSERT INTO entities (id, model, parent, name)
  3. INSERT INTO temp (id, created_at, updated_at, owner, size, mimetype)
  4. COMMIT
```

### UPDATE
```
Ring 5 SqlUpdate:
  - If parent/name changed → UPDATE entities
  - All other fields → UPDATE temp (detail table)
  - Both in transaction if both changed
```

### DELETE (soft)
```
Ring 5 SqlDelete:
  - UPDATE temp SET trashed_at = ? WHERE id = ?
  - entities table unchanged
  - EntityCache unchanged (still contains the entity)
```

### DELETE (hard)
```
DELETE FROM entities WHERE id = ?
  → CASCADE deletes from temp table automatically
```

## Implementation Plan

### Step 1: Schema (DONE)

The `entities` table and updated detail tables are in `schema.sql`:

```sql
-- Core identity table (4 columns only)
CREATE TABLE entities (
    id      TEXT PRIMARY KEY,
    model   TEXT NOT NULL,
    parent  TEXT REFERENCES entities(id),
    name    TEXT NOT NULL
);

-- Detail table with timestamps
CREATE TABLE temp (
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    owner       TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    mimetype    TEXT
);
```

### Step 2: Ring 5 Observers (DONE)

Updated to handle dual-table writes:
- `SqlCreate` - inserts into entities + detail in transaction
- `SqlUpdate` - updates entities (parent/name) and/or detail (other fields)
- `SqlDelete` - updates detail.trashed_at only

### Step 3: EntityCache (DONE)

Updated to load from entities table only:
```typescript
const entities = await db.query<CachedEntity>(
    'SELECT id, model, parent, name FROM entities'
);
```

No `WHERE trashed_at IS NULL` - cache contains ALL entities.

### Step 4: DatabaseOps Query JOIN (TODO)

Queries for entity models need to JOIN entities with detail tables to get full records:

```sql
-- Before (single table):
SELECT * FROM temp WHERE id = ?

-- After (join required):
SELECT e.id, e.model, e.parent, e.name,
       t.created_at, t.updated_at, t.trashed_at, t.expired_at,
       t.owner, t.size, t.mimetype
FROM entities e
JOIN temp t ON e.id = t.id
WHERE e.id = ?
```

Options:
1. DatabaseOps auto-joins for entity models
2. Explicit join in selectAny/selectOne
3. View per model (e.g., `temp_view` that joins)

### Step 5: VFS Path Resolution

EntityCache provides O(1) path resolution:

```typescript
async resolve(path: string): Promise<{ model: string; id: string }> {
    const entity = this.entityCache.resolvePath(path);
    if (!entity) {
        throw new ENOENT(path);
    }
    return { model: entity.model, id: entity.id };
}
```

No mount table needed - EntityCache already knows the model.

### Step 6: TempModel Implementation

Already implemented in `src/vfs/models/temp.ts`. Uses:
- `DatabaseOps` for SQL operations (flows through observer pipeline)
- `HAL.storage` for blob data
- Full POSIX file handle semantics

## What This Proves

Once `/tmp` works with entity+data architecture:

1. **Two-table pattern works** - entities for identity, detail for data
2. **Observer pipeline works for VFS** - setstat() validates via Ring 1, audits via Ring 7
3. **Cache efficiency** - entities table is minimal (4 columns)
4. **Soft-delete without cache invalidation** - detail table owns trashed_at
5. **SQL queryability** - Can query temp files: `SELECT * FROM temp WHERE size > 1000`
6. **Pattern is repeatable** - Can apply same approach to all models

## Future Expansion

After `/tmp` works:

| Path | Model | entities row | Detail table | Blob Storage |
|------|-------|--------------|--------------|--------------|
| `/tmp/*` | temp | ✓ | `temp` | HAL blob |
| `/vol/*` | file | ✓ | `file` | HAL blob |
| `/data/{model}/*` | user | ✓ | `{model}` | None (JSON only) |
| `/dev/*` | device | ✓ | `device` | None |
| `/proc/*` | proc | ✓ | `proc` | Dynamic |

## Acceptance Criteria

- [x] `entities` table exists with id, model, parent, name
- [x] Detail tables have timestamps + model-specific fields
- [x] Ring 5 observers handle dual-table writes
- [x] EntityCache loads from entities table only
- [ ] DatabaseOps queries JOIN entities with detail tables
- [ ] TempModel uses new architecture
- [ ] Can create file in `/tmp` via VFS
- [ ] `stat()` returns data from joined query
- [ ] `setstat()` goes through observer pipeline
- [ ] `read()`/`write()` use HAL blob storage
- [ ] Existing tests pass

## Open Questions

1. **Query JOIN strategy** - Should DatabaseOps auto-join, or explicit?
2. **View approach** - Create views per model for convenience?
3. **Denormalization** - Keep name/parent in both tables for query simplicity?

## Non-Goals (For Now)

- Nested folders in `/tmp` (flat only)
- Auto-expiration of temp files
- Full `/vol` migration
- `/data` path for user models

Keep it simple. Learn as we go.
