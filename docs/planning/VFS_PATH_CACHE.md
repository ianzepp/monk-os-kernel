# VFS PathCache (EntityCache Rewrite)

> **Status**: Phase 1 In Progress
> **Affects**: EMS, VFS, entity-cache.ts, Ring 8 observer

Rename EntityCache to PathCache and move ownership to VFS.

---

## Phased Approach

### Phase 1: Rename Only (Low Risk)

Mechanical refactoring - rename classes/files, move to VFS, update imports.
**No behavioral changes.**

| Change | Details |
|--------|---------|
| EntityCache → PathCache | Class rename |
| CachedEntity → PathEntry | Type rename |
| EntityInput → PathEntryInput | Type rename |
| EntityUpdate → PathEntryUpdate | Type rename |
| entity-cache.ts → path-cache.ts | File rename |
| src/ems/ → src/vfs/ | Move to VFS |
| EntityCacheSync → PathCacheSync | Observer rename |
| entityCache → pathCache | Property names |

### Phase 2: Lazy-Load Conversion (Future)

Convert from preload-all to lazy-load on cache miss. Requires design work for:
- Negative caching (non-existent paths)
- Batch loading (cold path penalty)
- Cache eviction (unbounded growth)
- getChildren() completeness tracking

**Phase 2 is NOT part of this PR.**

---

## Problem Statement

### Current State

`EntityCache` lives in `src/ems/entity-cache.ts` and:

1. **Misleading name** - doesn't cache entities, caches path resolution data
2. **Wrong owner** - lives in EMS but serves VFS path resolution
3. **Preloads everything** - `loadFromDatabase()` loads all entities at startup
4. **Startup coupling** - EMS.init() calls `loadFromDatabase()`, creating timing issues

### What EntityCache Actually Stores

```typescript
interface CachedEntity {
    id: string;
    model: string;      // VFS model type (file, folder, device, etc.)
    parent: string;     // parent entity ID
    pathname: string;   // path component name
}
```

This is **directory entry** (dentry) data for path resolution, not entity data.

### Issues with Preload-All

| Issue | Impact |
|-------|--------|
| Memory | ~250 bytes/entity, ~300MB for 1M entities |
| Startup | Must load ALL entities before VFS is ready |
| Scaling | Doesn't scale to large filesystems |
| Schema split | Complicates when to reload after VFS schema |

---

## Design

### Rename: EntityCache → PathCache

The name should reflect purpose:

| Old | New | Rationale |
|-----|-----|-----------|
| EntityCache | PathCache | Caches path resolution data |
| CachedEntity | PathEntry | Entry in the path cache |
| entity-cache.ts | path-cache.ts | File rename |

### Move: EMS → VFS

PathCache serves VFS, so VFS should own it:

```
Before: src/ems/entity-cache.ts
After:  src/vfs/path-cache.ts
```

### Convert: Preload → Lazy-Load

Instead of loading all entities at startup, load on cache miss:

```typescript
class PathCache {
    constructor(private readonly db: DatabaseConnection) {}

    async getById(id: string): Promise<PathEntry | null> {
        // Check cache
        const cached = this.byId.get(id);
        if (cached) return cached;

        // Cache miss → query DB
        const entry = await this.db.queryOne<PathEntry>(
            'SELECT id, model, parent, pathname FROM entities WHERE id = ?',
            [id]
        );

        if (entry) {
            this.addEntry(entry);
        }

        return entry ?? null;
    }

    async getChild(parentId: string | null, pathname: string): Promise<PathEntry | null> {
        const key = `${parentId ?? 'null'}:${pathname}`;

        // Check cache
        const id = this.childIndex.get(key);
        if (id) return this.byId.get(id) ?? null;

        // Cache miss → query DB
        const entry = await this.db.queryOne<PathEntry>(
            'SELECT id, model, parent, pathname FROM entities WHERE parent IS ? AND pathname = ?',
            [parentId, pathname]
        );

        if (entry) {
            this.addEntry(entry);
        }

        return entry ?? null;
    }
}
```

### Remove: loadFromDatabase()

No longer needed. Cache self-populates on demand.

**Before:**
```typescript
// EMS.init()
this._cache = new EntityCache();
await this._cache.loadFromDatabase(this._db);
```

**After:**
```typescript
// VFS.init()
this._pathCache = new PathCache(this.ems.db);
// No preload - cache populates lazily
```

---

## Path Resolution Flow

### Before (Preload-All)

```
Startup:
  EMS.init() → loadFromDatabase() → 1M entities loaded → ready

Runtime:
  resolvePath("/home/user/docs")
    → childIndex.get("root:home")     → uuid-A  (cache hit)
    → childIndex.get("uuid-A:user")   → uuid-B  (cache hit)
    → childIndex.get("uuid-B:docs")   → uuid-C  (cache hit)
```

### After (Lazy-Load)

```
Startup:
  VFS.init() → new PathCache(db) → empty cache → ready

Runtime (first access):
  resolvePath("/home/user/docs")
    → getChild(ROOT_ID, "home")       → cache miss → SQL → uuid-A
    → getChild("uuid-A", "user")      → cache miss → SQL → uuid-B
    → getChild("uuid-B", "docs")      → cache miss → SQL → uuid-C

Runtime (subsequent):
  resolvePath("/home/user/docs")
    → getChild(ROOT_ID, "home")       → cache hit → uuid-A
    → getChild("uuid-A", "user")      → cache hit → uuid-B
    → getChild("uuid-B", "docs")      → cache hit → uuid-C
```

---

## Root Entity Handling

With lazy loading, the root entity seed in VFS schema "just works":

1. VFS schema: `INSERT OR IGNORE INTO entities (id, ...) VALUES (ROOT_ID, ...)`
2. PathCache starts empty
3. First path resolution queries for root
4. DB returns seeded root
5. PathCache caches it

No special handling, no `reloadEntities` option needed.

---

## Ring 8 Observer

The EntityCacheSync observer continues to work but needs updates:

### Before

```typescript
// src/ems/ring/8/60-entity-cache.ts
const entityCache = (system as { entityCache?: unknown }).entityCache;
```

### After

```typescript
// src/ems/ring/8/60-path-cache.ts (or keep in ems/ring)
const pathCache = (system as { pathCache?: unknown }).pathCache;
```

The observer:
- Remains in EMS (it hooks into the observer pipeline)
- Gets PathCache reference via SystemContext
- VFS provides the PathCache instance to SystemContext

This maintains separation:
- EMS owns the observer pipeline
- VFS owns PathCache
- Observer updates PathCache via interface

---

## Files to Change

### Rename/Move

| From | To |
|------|-----|
| `src/ems/entity-cache.ts` | `src/vfs/path-cache.ts` |
| `src/ems/ring/8/60-entity-cache.ts` | `src/ems/ring/8/60-path-cache.ts` |

### Modify

| File | Change |
|------|--------|
| `src/vfs/path-cache.ts` | Rename class, add lazy-load methods, remove `loadFromDatabase()` |
| `src/ems/ring/8/60-path-cache.ts` | Update class/interface names |
| `src/ems/ems.ts` | Remove EntityCache creation and `loadFromDatabase()` call |
| `src/vfs/vfs.ts` | Create PathCache, provide to SystemContext |
| `src/ems/entity-ops.ts` | Update SystemContext setup (pathCache instead of entityCache) |
| `src/ems/observers/interfaces.ts` | Rename EntityCacheAdapter → PathCacheAdapter |

### Update Imports

Any file importing from `entity-cache.ts`:

```typescript
// Before
import { EntityCache, ROOT_ID } from '@src/ems/entity-cache.js';

// After
import { PathCache, ROOT_ID } from '@src/vfs/path-cache.js';
```

### Tests

| File | Change |
|------|--------|
| `spec/ems/entity-cache.test.ts` | Move to `spec/vfs/path-cache.test.ts`, update for lazy-load |

---

## Interface Changes

### PathEntry (was CachedEntity)

```typescript
interface PathEntry {
    id: string;
    model: string;
    parent: string | null;
    pathname: string;
}
```

### PathCache (was EntityCache)

```typescript
class PathCache {
    constructor(db: DatabaseConnection);

    // Lazy-load lookups
    async getById(id: string): Promise<PathEntry | null>;
    async getChild(parentId: string | null, pathname: string): Promise<PathEntry | null>;
    async getChildren(parentId: string): Promise<PathEntry[]>;

    // Cache mutation (called by Ring 8 observer)
    addEntry(entry: PathEntry): void;
    updateEntry(id: string, changes: { pathname?: string; parent?: string | null }): void;
    removeEntry(id: string): void;

    // Cache management
    clear(): void;

    // Path utilities
    async resolvePath(path: string): Promise<string | null>;
    async computePath(id: string): Promise<string>;
}
```

### PathCacheAdapter (for Ring 8 observer)

```typescript
interface PathCacheAdapter {
    addEntry(entry: PathEntry): void;
    updateEntry(id: string, changes: { pathname?: string; parent?: string | null }): void;
    removeEntry(id: string): void;
}
```

---

## Implementation Steps

### Phase 1 Steps (Current)

#### Step 1: Create PathCache in VFS

1. Copy `entity-cache.ts` to `src/vfs/path-cache.ts`
2. Rename EntityCache → PathCache, CachedEntity → PathEntry
3. Rename EntityInput → PathEntryInput, EntityUpdate → PathEntryUpdate
4. Keep all existing behavior (including `loadFromDatabase()`)

#### Step 2: Update Ring 8 Observer

1. Rename file to `60-path-cache.ts`
2. Rename EntityCacheSync → PathCacheSync
3. Rename EntityCacheAdapter → PathCacheAdapter
4. Update SystemContext property name: `entityCache` → `pathCache`

#### Step 3: Update EMS

1. Update import path in `ems.ts` (now from vfs/path-cache)
2. Rename `_cache` → `_pathCache`, `cache` accessor → `pathCache`
3. Update `entity-ops.ts`: `entityCache` → `pathCache`

#### Step 4: Update Exports

1. Update `src/ems/index.ts` - re-export from new location
2. Update `src/ems/ring/8/index.ts` - use new observer name
3. Update `src/vfs/index.ts` - export PathCache

#### Step 5: Update Tests

1. Move `spec/ems/entity-cache.test.ts` → `spec/vfs/path-cache.test.ts`
2. Update class/type names in tests

#### Step 6: Cleanup

1. Delete old `src/ems/entity-cache.ts`
2. Delete old `src/ems/ring/8/60-entity-cache.ts`

---

### Phase 2 Steps (Future)

1. Remove `loadFromDatabase()` from PathCache
2. Add lazy-load on cache miss
3. Add negative caching
4. Add batch loading for cold paths
5. Add LRU eviction
6. Update tests for lazy-load behavior

---

## Deduplication of Concurrent Requests

The current EntityCache has pending request deduplication:

```typescript
private readonly pending: Map<string, Promise<Model | undefined>>;
```

PathCache should have the same for lazy-load queries:

```typescript
private readonly pendingById: Map<string, Promise<PathEntry | null>>;
private readonly pendingByChild: Map<string, Promise<PathEntry | null>>;

async getById(id: string): Promise<PathEntry | null> {
    // Check cache
    if (this.byId.has(id)) return this.byId.get(id)!;

    // Check pending
    if (this.pendingById.has(id)) return this.pendingById.get(id)!;

    // Start query, cache promise
    const promise = this.loadById(id);
    this.pendingById.set(id, promise);

    try {
        return await promise;
    } finally {
        this.pendingById.delete(id);
    }
}
```

---

## Open Questions

1. **ROOT_ID constant** - Should it move to VFS with PathCache, or stay shared?

2. **Cache eviction** - With lazy loading, cache grows unbounded. Add LRU eviction?

3. **Warm-up API** - Should PathCache have optional `preload(paths: string[])` for known hot paths?

4. **getChildren() caching** - Should `getChildren()` cache the "complete children loaded" state to avoid repeated queries?

---

## References

- `src/ems/entity-cache.ts` - Current implementation
- `src/ems/ring/8/60-entity-cache.ts` - Ring 8 sync observer
- `src/ems/ems.ts` - Current EntityCache initialization
- `src/vfs/vfs.ts` - VFS that will own PathCache
- `docs/planning/EMS_SCHEMA_SPLIT.md` - Related schema split work
