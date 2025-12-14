# PATH_CACHE_STALE: Path Cache Contains Soft-Deleted Entities

## Summary

The PathCache loads all entries from the `entities` table at boot, including entities that were soft-deleted in previous boots. This causes path resolution to return stale entity IDs that fail when the VFS tries to query the detail tables (which correctly filter by `trashed_at`).

## Symptoms

- VFS operations fail with "Entity not found" errors for paths that appear to exist
- `stat()` returns null for directories that exist in the path cache
- Kernel init fails with `ENOTDIR: Not a directory: /etc/services` even though `/etc/services` doesn't exist in the ROM
- Debug output shows path cache has entries, but stat queries fail:
  ```
  [os:init] stat /etc failed: Entity not found: 019b0e89-6c84-71cd-9995-294dcee76f68
  ```

## Root Cause

### The Two-Table Architecture

Monk OS uses a two-table architecture for VFS entities:

1. **`entities` table** - Stores identity and hierarchy:
   - `id` (UUID)
   - `model` (e.g., "file", "folder")
   - `parent` (UUID of parent entity)
   - `pathname` (name component, not full path)
   - **No `trashed_at` column**

2. **Detail tables** (`file`, `folder`, etc.) - Store model-specific data:
   - `id` (same UUID as entities)
   - `created_at`, `updated_at`, `trashed_at`
   - Model-specific fields (e.g., `data`, `size` for files)

### The Soft-Delete Design

When an entity is soft-deleted:
1. `EntityOps.deleteAll()` sets `trashed_at` in the **detail table** only
2. The `entities` table row remains unchanged
3. The PathCacheSync Ring 8 observer calls `cache.removeEntry(id)` to update the in-memory cache

### The Bug

The PathCache loads from the `entities` table at EMS init:

```typescript
// src/vfs/path-cache.ts:261-263
const entities = await db.query<PathEntry>(
    'SELECT id, model, parent, pathname FROM entities',
);
```

This query returns ALL entities, including those that were soft-deleted in previous boots. The `entities` table has no `trashed_at` column to filter on.

### The Failure Sequence

1. **Previous boot**: User deletes `/etc/services` directory
   - `folder.trashed_at` is set in the `folder` table
   - PathCacheSync removes entry from in-memory cache
   - Boot completes successfully

2. **Current boot**: EMS initializes
   - PathCache loads from `entities` table
   - `/etc/services` is included (no trashed_at filter)
   - Cache now contains stale entry

3. **Current boot**: OS tries to `rmtree('/etc')`
   - `stat('/etc')` queries `folder` table
   - `folder` table has `trashed_at` set → returns "not found"
   - `rmtree` catches ENOENT and continues

4. **Current boot**: Kernel initializes
   - `loadServices()` does `stat('/etc/services')` → succeeds (path cache hit)
   - Tries `readdir('/etc/services')` → queries `folder` table
   - Finds entity is trashed → **ENOTDIR error**

## Impact

- **ROM sync broken**: Changes to `rom/` files aren't picked up because `rmtree` silently fails on already-trashed paths
- **Stale paths resolvable**: Deleted files/folders appear to exist until detail table is queried
- **Cascading failures**: Children of deleted directories remain in path cache, causing confusing errors

## Affected Code

- `src/vfs/path-cache.ts:loadFromDatabase()` - Loads without filtering trashed
- `src/ems/ring/5/50-sql-delete.ts` - Only updates detail table, not entities
- `src/ems/ring/8/60-path-cache.ts` - Correctly removes from cache, but only for current boot

## Potential Fixes

### Option 1: Add `trashed_at` to `entities` table

**Pros**: Clean, single-source-of-truth for soft-delete status
**Cons**: Schema migration required, redundant data

```sql
ALTER TABLE entities ADD COLUMN trashed_at TIMESTAMPTZ;
```

Then filter in loadFromDatabase:
```typescript
const entities = await db.query<PathEntry>(
    'SELECT id, model, parent, pathname FROM entities WHERE trashed_at IS NULL',
);
```

SqlDelete observer would need to UPDATE both tables.

### Option 2: JOIN with detail tables in loadFromDatabase

**Pros**: No schema change
**Cons**: Complex query, must enumerate all VFS model tables

```sql
SELECT e.id, e.model, e.parent, e.pathname
FROM entities e
LEFT JOIN file f ON e.id = f.id
LEFT JOIN folder fo ON e.id = fo.id
WHERE COALESCE(f.trashed_at, fo.trashed_at) IS NULL
```

This breaks if new VFS models are added without updating the query.

### Option 3: Hard-delete from `entities` on soft-delete

**Pros**: Simple, path cache stays clean
**Cons**: Breaks "untrash" functionality (can't restore soft-deleted entities)

Modify SqlDelete to:
```typescript
await system.db.execute(`DELETE FROM entities WHERE id = ${p1}`, [id]);
```

### Option 4: Cleanup orphaned entities at boot

**Pros**: No schema change, preserves untrash capability
**Cons**: Extra boot-time query, doesn't fix root cause

Add a cleanup step before loading path cache:
```sql
DELETE FROM entities e
WHERE EXISTS (
    SELECT 1 FROM file f WHERE f.id = e.id AND f.trashed_at IS NOT NULL
) OR EXISTS (
    SELECT 1 FROM folder fo WHERE fo.id = e.id AND fo.trashed_at IS NOT NULL
)
```

### Option 5: Store soft-delete in path cache entry

**Pros**: No schema change, fast filtering
**Cons**: Cache structure change, more memory per entry

Add `trashed: boolean` to PathEntry, populate via JOIN at load time, filter during resolution.

## Recommended Fix

**Option 1 (Add `trashed_at` to entities)** is the cleanest long-term solution:

1. It's the single source of truth
2. Simple WHERE clause in loadFromDatabase
3. Enables future features like "show deleted files"
4. Consistent with how other systems handle soft-delete

Implementation steps:
1. Add migration to add `trashed_at` column to `entities`
2. Backfill: `UPDATE entities e SET trashed_at = f.trashed_at FROM file f WHERE e.id = f.id`
3. Repeat for `folder` and other VFS models
4. Modify `SqlDelete` observer to update `entities.trashed_at`
5. Modify `loadFromDatabase` to filter by `trashed_at IS NULL`
6. Modify `PathCacheSync` to handle untrash (clear trashed_at)

## Workaround

Until fixed, reset the database between boots if ROM changes aren't being picked up:

```bash
dropdb monk_os && createdb monk_os
```

Or use in-memory storage which starts fresh each boot:

```bash
bun run start --memory
```

## Related Files

- `src/vfs/path-cache.ts` - PathCache implementation
- `src/ems/ring/5/50-sql-delete.ts` - Soft-delete SQL observer
- `src/ems/ring/8/60-path-cache.ts` - PathCacheSync observer
- `src/vfs/models/entity.ts` - EntityModel.unlink()
- `src/os/os.ts` - Boot sequence with rmtree

## Test Case

```typescript
// 1. Boot with persistent storage
// 2. Create /test/file.txt
// 3. Delete /test directory
// 4. Shutdown
// 5. Boot again
// 6. stat('/test') should return null
// 7. Currently: stat returns stale cache hit, then fails on detail query
```
