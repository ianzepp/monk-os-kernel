# VFS PathCache (EntityCache Rewrite)

> **Status**: Phase 1 Complete
> **Implemented**: 2025-12-08
> **Commit**: a9cff4d

Rename EntityCache to PathCache and move ownership to VFS.

---

## Summary

Phase 1 (rename only) is complete. The misleading `EntityCache` name has been
changed to `PathCache` to reflect its actual purpose: caching path resolution
data (parent, pathname, model) rather than full entity data.

Phase 2 (lazy-load conversion) remains future work.

---

## What Was Done (Phase 1)

### Files Renamed/Moved

| From | To |
|------|-----|
| `src/ems/entity-cache.ts` | `src/vfs/path-cache.ts` |
| `src/ems/ring/8/60-entity-cache.ts` | `src/ems/ring/8/60-path-cache.ts` |
| `spec/ems/entity-cache.test.ts` | `spec/vfs/path-cache.test.ts` |
| `spec/ems/ring/8/entity-cache.test.ts` | `spec/ems/ring/8/path-cache.test.ts` |
| `perf/ems/entity-cache.perf.ts` | `perf/vfs/path-cache.perf.ts` |

### Classes/Types Renamed

| Old | New |
|-----|-----|
| `EntityCache` | `PathCache` |
| `CachedEntity` | `PathEntry` |
| `EntityInput` | `PathEntryInput` |
| `EntityUpdate` | `PathEntryUpdate` |
| `CacheStats` | `PathCacheStats` |
| `EntityCacheSync` | `PathCacheSync` |

### Properties/Methods Renamed

| Old | New |
|-----|-----|
| `ems.cache` | `ems.pathCache` |
| `system.entityCache` | `system.pathCache` |
| `addEntity()` | `addEntry()` |
| `updateEntity()` | `updateEntry()` |
| `removeEntity()` | `removeEntry()` |
| `getEntity()` | `getEntry()` |
| `hasEntity()` | `hasEntry()` |
| `getAllEntities()` | `getAllEntries()` |

### Behavior

No behavioral changes. PathCache still:
- Preloads all entries via `loadFromDatabase()`
- Lives in EMS initialization flow
- Uses same indexes (byId, childIndex, childrenOf)

---

## What Remains (Phase 2 - Future)

Convert from preload-all to lazy-load on cache miss:

1. Remove `loadFromDatabase()` from PathCache
2. Add lazy-load on cache miss (query DB when entry not in cache)
3. Add negative caching (cache "not found" results)
4. Add batch loading for cold paths (reduce N+1 queries)
5. Add LRU eviction (prevent unbounded memory growth)
6. Add getChildren() completeness tracking

### Open Questions for Phase 2

1. **ROOT_ID constant** - Currently in PathCache. Should it move to shared location?
2. **Cache eviction** - LRU? Time-based? Size-based?
3. **Warm-up API** - Optional `preload(paths: string[])` for hot paths?
4. **Transaction visibility** - How to handle queries during uncommitted transactions?

---

## Original Problem Statement

`EntityCache` was a misleading name because it:
1. Doesn't cache entities - caches path resolution data (dentry-like)
2. Lived in EMS but served VFS path resolution
3. Preloads everything at startup (~300MB for 1M entities)

The rename to `PathCache` clarifies the actual purpose.

---

## References

- `src/vfs/path-cache.ts` - PathCache implementation
- `src/ems/ring/8/60-path-cache.ts` - Ring 8 sync observer
- `spec/vfs/path-cache.test.ts` - Unit tests
- `perf/vfs/path-cache.perf.ts` - Performance tests
