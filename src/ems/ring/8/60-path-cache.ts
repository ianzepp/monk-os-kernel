/**
 * PathCache Observer - Ring 8 Integration
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * PathCacheSync is a Ring 8 observer that keeps the PathCache in sync
 * with database mutations. When entities are created, updated, or deleted,
 * this observer updates the in-memory cache.
 *
 * Unlike the ModelCache (Ring 8 priority 50) which caches model metadata,
 * PathCache stores path resolution data for VFS lookups. This observer
 * runs at priority 60 (after model cache invalidation).
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll('file', { pathname: 'doc.txt', parent: ROOT_ID })
 *     │
 * Ring 5: INSERT INTO file (...) ◄── entity persisted
 *     │
 * Ring 8 (50): Model cache invalidation (if applicable)
 *     │
 * Ring 8 (60, this): ──► pathCache.addEntry(...) ◄── cache updated
 *     │
 * Path resolution now works for new entity
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Runs for all tables EXCEPT meta-tables (models, fields, tracked)
 * INV-2: Requires id, pathname, parent fields on the record
 * INV-3: Runs after database persistence (Ring 5)
 * INV-4: PathCache is eventually consistent with database
 *
 * SUPPORTED OPERATIONS
 * ====================
 * - create: Adds new entry to cache
 * - update: Updates entry (handles rename and move)
 * - delete: Removes entry from cache (soft delete still removes from cache)
 *
 * @module model/ring/8/path-cache
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext, ModelRecord } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Meta-tables that don't have entries in PathCache.
 *
 * WHY excluded: These are schema tables, not VFS entities.
 * They don't have parent/name fields for path resolution.
 */
const META_TABLES = new Set(['models', 'fields', 'tracked']);

// =============================================================================
// PATH CACHE SYNC OBSERVER
// =============================================================================

/**
 * Syncs PathCache with database mutations.
 *
 * WHY priority 60: Runs after model cache invalidation (50).
 * Model definitions should be invalidated before we update path cache.
 *
 * WHY Ring 8: Post-database integration. Entity must be persisted
 * before we can add it to the cache (need the auto-generated ID).
 */
export class PathCacheSync extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'PathCacheSync';

    /**
     * Ring 8 = Integration.
     */
    readonly ring = ObserverRing.Integration;

    /**
     * Priority 60 = after model cache invalidation.
     */
    readonly priority = 60;

    /**
     * Handle all mutation operations.
     */
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Update PathCache based on operation.
     *
     * ALGORITHM:
     * 1. Skip meta-tables (no path resolution needed)
     * 2. Skip if pathCache not available on system context
     * 3. Extract entry data from record
     * 4. Apply appropriate cache mutation
     *
     * @param context - Observer context
     */
    async execute(context: ObserverContext): Promise<void> {
        const { system, operation, model, record } = context;

        // Skip meta-tables
        if (META_TABLES.has(model.modelName)) {
            return;
        }

        // Skip if no path cache on system context
        // This can happen during testing or before cache is initialized
        const pathCache = (system as { pathCache?: unknown }).pathCache as
            | PathCacheAdapter
            | undefined;

        if (!pathCache) {
            return;
        }

        // Extract entity ID
        const id = record.get('id') as string;

        if (!id) {
            return; // No ID (shouldn't happen after Ring 5)
        }

        switch (operation) {
            case 'create':
                this.handleCreate(pathCache, model.modelName, record);
                break;

            case 'update':
                this.handleUpdate(pathCache, id, record);
                break;

            case 'delete':
                this.handleDelete(pathCache, id);
                break;
        }
    }

    /**
     * Handle entity creation.
     */
    private handleCreate(cache: PathCacheAdapter, modelName: string, record: ModelRecord): void {
        const id = record.get('id') as string;
        const parent = record.get('parent') as string | null;
        const pathname = record.get('pathname') as string;

        // Defensive: all entities need pathname (except root)
        if (!pathname && parent !== null) {
            return;
        }

        cache.addEntry({
            id,
            model: modelName,
            parent: parent ?? null,
            pathname: pathname ?? '',
        });
    }

    /**
     * Handle entity update.
     *
     * Checks for pathname and parent changes, applies to cache.
     */
    private handleUpdate(cache: PathCacheAdapter, id: string, record: ModelRecord): void {
        const changes: { pathname?: string; parent?: string | null } = {};

        // Check for rename (has() returns true if field was changed)
        if (record.has('pathname')) {
            const newPathname = record.get('pathname') as string;
            const oldPathname = record.old('pathname') as string;

            if (newPathname !== oldPathname) {
                changes.pathname = newPathname;
            }
        }

        // Check for move
        if (record.has('parent')) {
            const newParent = record.get('parent') as string | null;
            const oldParent = record.old('parent') as string | null;

            if (newParent !== oldParent) {
                changes.parent = newParent ?? null;
            }
        }

        // Apply changes if any
        if (Object.keys(changes).length > 0) {
            cache.updateEntry(id, changes);
        }
    }

    /**
     * Handle entity deletion.
     *
     * Removes entry from cache. This runs for soft deletes too
     * (trashed_at set) because soft-deleted entities should not
     * appear in path resolution.
     */
    private handleDelete(cache: PathCacheAdapter, id: string): void {
        cache.removeEntry(id);
    }
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Minimal interface for PathCache.
 *
 * WHY interface: Avoids circular imports. The actual PathCache class
 * implements these methods.
 */
interface PathCacheAdapter {
    addEntry(input: { id: string; model: string; parent: string | null; pathname: string }): void;
    updateEntry(id: string, changes: { pathname?: string; parent?: string | null }): void;
    removeEntry(id: string): void;
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default PathCacheSync;
