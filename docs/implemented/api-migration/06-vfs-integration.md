# Phase 6: VFS Integration

## Prerequisites

- [Phase 5.5: Entity Cache](./05.5-entity-cache.md) - Required for O(1) path resolution and model dispatch
- [Phase 6.1: Entities Table](./06.1-entities-table.md) - Core identity + hierarchy table

## Overview

Wire VFS operations to the entity+data architecture using a polymorphic EntityModel.

## Architecture

The architecture uses a two-table design with **polymorphic hierarchy**:

```
/home/ian/project/config.yaml
    │
    ├── entities table ──────────────────────┐
    │   (identity + hierarchy)               │
    │   - id, model, parent, pathname        │
    │   - NO timestamps (cache efficiency)   │
    │                                        │
    │   EntityCache loads this table         │
    │   Path resolution returns id + model   │
    │                                        │
    ├── {model} table (detail) ──────────────┤
    │   - id (FK → entities.id)              │
    │   - created_at, updated_at             │
    │   - trashed_at, expired_at             │
    │   - model-specific fields              │
    │                                        │
    │   stat() ──► query detail by id        │
    │   setstat() ──► Observer pipeline      │
    │                                        │
    └── Data (HAL) ──────────────────────────┘
        blob storage (keyed by entity id)

        read() ──► HAL.storage.get(id)
        write() ──► HAL.storage.put(id, data)
```

**Key principles:**
- `entities` table = VFS namespace (polymorphic - any model at any path)
- `pathname` derived from model field (configurable via `models.pathname`)
- Detail tables = timestamps + model-specific fields
- Trashing updates detail table only (cache unchanged)
- Blob data in HAL (direct I/O)

## Polymorphic Hierarchy

The `entities` table stores `model` per-entity, enabling fully polymorphic hierarchy:

```
/home/                     (folder)
├── ian/                   (user)
│   ├── settings.json      (config)
│   ├── avatar.png         (file)
│   └── project/           (folder)
│       ├── README.md      (file)
│       └── api-key        (secret)
└── system/                (folder)
    └── printer            (device)
```

**No mount points needed.** Any VFS-addressable model can exist at any path. The model is determined by querying EntityCache, not by path prefix.

## VFS-Addressable Models

Not all models need VFS paths. The `models.pathname` column specifies which field becomes the path:

| Model | models.pathname | Entity pathname derived from |
|-------|-----------------|------------------------------|
| file | `'filename'` | file.filename → `README.md` |
| user | `'username'` | user.username → `ian` |
| config | `'key'` | config.key → `settings.json` |
| logs | `NULL` | No entities row (not VFS) |

- If `pathname` is set → model is VFS-addressable, entities row created
- If `pathname` is NULL → model is data-only, no entities row

## Data Flow

### CREATE
```
Ring 5 SqlCreate (priority 50):
  - If models.pathname is NULL → INSERT into detail table only
  - If models.pathname is set:
    1. BEGIN TRANSACTION
    2. INSERT INTO entities (id, model, parent, pathname)
    3. INSERT INTO detail table (id, timestamps, fields)
    4. COMMIT
```

### UPDATE
```
Ring 5 SqlUpdate (priority 50):
  - If parent changed → UPDATE entities.parent
  - Other fields → UPDATE detail table

Ring 5 PathnameSync (priority 60):
  - If pathname source field changed (e.g., user.username):
    → UPDATE entities SET pathname = ? WHERE id = ?

Ring 8 EntityCacheSync:
  - If entities.pathname changed:
    → Update cache indexes (remove old, add new)
```

### DELETE (soft)
```
Ring 5 SqlDelete:
  - UPDATE detail SET trashed_at = ? WHERE id = ?
  - entities table unchanged
  - EntityCache unchanged (still contains the entity)
```

### DELETE (hard)
```
Ring 5 SqlDelete:
  - DELETE FROM entities WHERE id = ?
  - DELETE FROM {model} WHERE id = ? (explicit, no cascade)
```

## Implementation Plan

### Step 1: Schema

**entities table** (4 columns only, no FKs):
```sql
CREATE TABLE entities (
    id       TEXT PRIMARY KEY,
    model    TEXT NOT NULL,
    parent   TEXT,  -- no FK, avoids boot ordering issues
    pathname TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_entities_parent_pathname ON entities(parent, pathname);
```

**models table** (add pathname column):
```sql
ALTER TABLE models ADD COLUMN pathname TEXT;
-- NULL = not VFS-addressable
-- 'fieldname' = that field becomes the pathname
```

**Detail tables** (timestamps + model-specific fields, no FKs):
```sql
CREATE TABLE file (
    id          TEXT PRIMARY KEY,  -- same as entities.id, no FK
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    owner       TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    mimetype    TEXT
);
```

### Step 2: Ring 5 Observers

| Observer | Priority | Responsibility |
|----------|----------|----------------|
| SqlCreate | 50 | INSERT entities (if VFS) + INSERT detail |
| SqlUpdate | 50 | UPDATE entities.parent, UPDATE detail |
| SqlDelete | 50 | UPDATE detail.trashed_at |
| PathnameSync | 60 | UPDATE entities.pathname when source field changes |

**PathnameSync** (new observer):
```typescript
// Ring 5, priority 60 (after SqlUpdate)
// On UPDATE: check if pathname source field changed
// If so: UPDATE entities SET pathname = ? WHERE id = ?
```

### Step 3: Ring 8 Cache Sync

**EntityCacheSync** handles:
- CREATE: Add to cache
- UPDATE: If pathname changed, update cache indexes
- DELETE: Remove from cache (hard delete only)

### Step 4: EntityCache Load

Load from entities table:
```typescript
const entities = await db.query<CachedEntity>(
    'SELECT id, model, parent, pathname FROM entities'
);
```

No `WHERE trashed_at IS NULL` - cache contains ALL entities.

### Step 5: VFS Path Resolution (DONE)

EntityCache provides O(1) path resolution with DB fallback on cache miss:

```typescript
async resolvePath(path: string, db?: DatabaseConnection): Promise<string | null> {
    // Split path into components, start at ROOT_ID
    for (const pathname of components) {
        let childId = this.childIndex.get(key);

        // Cache miss - query entities table directly
        if (!childId && db) {
            childId = await this.resolveFromDatabase(db, currentId, pathname);
        }

        if (!childId) return null;
        currentId = childId;
    }
    return currentId;
}

private async resolveFromDatabase(db, parentId, pathname): Promise<string | undefined> {
    const rows = await db.query<CachedEntity>(
        'SELECT id, model, parent, pathname FROM entities WHERE parent = ? AND pathname = ?',
        [parentId, pathname]
    );
    if (rows[0]) {
        this.addEntity(rows[0]); // Populate cache for future lookups
    }
    return rows[0]?.id;
}
```

**Key insight:** No JOINs needed. On cache miss, query only the `entities` table and populate the cache. Detail table queries happen separately when model-specific fields are needed.

### Step 6: EntityModel (Polymorphic VFS Model)

A single `EntityModel` handles all VFS operations by delegating to the correct detail table based on the entity's model:

```typescript
class EntityModel implements VfsModel {
    async stat(id: string): Promise<Stat> {
        const entity = this.cache.getEntity(id);
        if (!entity) throw new ENOENT();

        // Query the correct detail table based on entity.model
        const detail = await this.db.selectOne(entity.model, { id });
        return { ...entity, ...detail };
    }

    async setstat(id: string, changes: Partial<Stat>): Promise<void> {
        const entity = this.cache.getEntity(id);
        if (!entity) throw new ENOENT();

        // Update flows through observer pipeline for entity.model
        await this.db.update(entity.model, { id }, changes);
    }

    async read(id: string): Promise<Uint8Array> {
        return this.hal.storage.get(id);
    }

    async write(id: string, data: Uint8Array): Promise<void> {
        await this.hal.storage.put(id, data);
    }
}
```

**Key insight:** The VFS doesn't need model-specific implementations. EntityModel uses `entity.model` from the cache to dispatch to the correct detail table.

## What This Proves

1. **Polymorphic hierarchy works** - Any model at any path, no mount points
2. **Two-table pattern works** - entities for identity, detail for data
3. **Observer pipeline works for VFS** - setstat() validates via Ring 1, audits via Ring 7
4. **Cache efficiency** - entities table is minimal (4 columns)
5. **Soft-delete without cache invalidation** - detail table owns trashed_at
6. **SQL queryability** - Can query any model: `SELECT * FROM file WHERE size > 1000`
7. **Single VFS model** - EntityModel handles all entity types

## Acceptance Criteria

- [ ] `entities` table exists with id, model, parent, pathname
- [ ] `models` table has `pathname` column
- [ ] Detail tables have timestamps + model-specific fields
- [ ] Ring 5 SqlCreate checks `models.pathname` before creating entities row
- [ ] Ring 5 PathnameSync observer syncs pathname field → entities.pathname
- [ ] Ring 8 EntityCacheSync updates cache when pathname changes
- [x] EntityCache loads from entities table (id, model, parent, pathname)
- [x] EntityCache.resolvePath() has DB fallback on cache miss (no JOINs needed)
- [ ] EntityModel dispatches to correct detail table based on entity.model
- [ ] Can create any VFS-addressable entity via VFS
- [ ] `stat()` returns data from entity + detail
- [ ] `setstat()` goes through observer pipeline
- [ ] `read()`/`write()` use HAL blob storage
- [ ] Existing tests pass

## Open Questions

1. **pathname uniqueness** - Enforce unique (parent, pathname) in entities?

## Resolved Questions

1. ~~**Query JOIN strategy**~~ - No JOINs needed. EntityCache queries `entities` table on cache miss, detail tables queried separately when needed.
2. ~~**View approach**~~ - Not needed given the above.
3. ~~**Mount points**~~ - Not needed. Polymorphic hierarchy means any model at any path.

## Non-Goals (For Now)

- Auto-expiration of entities
- Recursive delete cascading through children

Keep it simple. Learn as we go.
