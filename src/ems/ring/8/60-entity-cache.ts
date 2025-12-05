/**
 * EntityCache Observer - Ring 8 Integration
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EntityCacheSync is a Ring 8 observer that keeps the EntityCache in sync
 * with database mutations. When entities are created, updated, or deleted,
 * this observer updates the in-memory cache.
 *
 * Unlike the ModelCache (Ring 8 priority 50) which caches model metadata,
 * EntityCache stores entity instances for path resolution. This observer
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
 * Ring 8 (60, this): ──► entityCache.addEntity(...) ◄── cache updated
 *     │
 * Path resolution now works for new entity
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Runs for all tables EXCEPT meta-tables (models, fields, tracked)
 * INV-2: Requires id, pathname, parent fields on the record
 * INV-3: Runs after database persistence (Ring 5)
 * INV-4: EntityCache is eventually consistent with database
 *
 * SUPPORTED OPERATIONS
 * ====================
 * - create: Adds new entity to cache
 * - update: Updates entity (handles rename and move)
 * - delete: Removes entity from cache (soft delete still removes from cache)
 *
 * @module model/ring/8/entity-cache
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext, ModelRecord } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Meta-tables that don't have entities in EntityCache.
 *
 * WHY excluded: These are schema tables, not VFS entities.
 * They don't have parent/name fields for path resolution.
 */
const META_TABLES = new Set(['models', 'fields', 'tracked']);

// =============================================================================
// ENTITY CACHE SYNC OBSERVER
// =============================================================================

/**
 * Syncs EntityCache with database mutations.
 *
 * WHY priority 60: Runs after model cache invalidation (50).
 * Model definitions should be invalidated before we update entity cache.
 *
 * WHY Ring 8: Post-database integration. Entity must be persisted
 * before we can add it to the cache (need the auto-generated ID).
 */
export class EntityCacheSync extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'EntityCacheSync';

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
     * Update EntityCache based on operation.
     *
     * ALGORITHM:
     * 1. Skip meta-tables (no path resolution needed)
     * 2. Skip if entityCache not available on system context
     * 3. Extract entity data from record
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

        // Skip if no entity cache on system context
        // This can happen during testing or before cache is initialized
        const entityCache = (system as { entityCache?: unknown }).entityCache as
            | EntityCacheAdapter
            | undefined;

        if (!entityCache) {
            return;
        }

        // Extract entity ID
        const id = record.get('id') as string;

        if (!id) {
            return; // No ID (shouldn't happen after Ring 5)
        }

        switch (operation) {
            case 'create':
                this.handleCreate(entityCache, model.modelName, record);
                break;

            case 'update':
                this.handleUpdate(entityCache, id, record);
                break;

            case 'delete':
                this.handleDelete(entityCache, id);
                break;
        }
    }

    /**
     * Handle entity creation.
     */
    private handleCreate(cache: EntityCacheAdapter, modelName: string, record: ModelRecord): void {
        const id = record.get('id') as string;
        const parent = record.get('parent') as string | null;
        const pathname = record.get('pathname') as string;

        // Defensive: all entities need pathname (except root)
        if (!pathname && parent !== null) {
            return;
        }

        cache.addEntity({
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
    private handleUpdate(cache: EntityCacheAdapter, id: string, record: ModelRecord): void {
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
            cache.updateEntity(id, changes);
        }
    }

    /**
     * Handle entity deletion.
     *
     * Removes entity from cache. This runs for soft deletes too
     * (trashed_at set) because soft-deleted entities should not
     * appear in path resolution.
     */
    private handleDelete(cache: EntityCacheAdapter, id: string): void {
        cache.removeEntity(id);
    }
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Minimal interface for EntityCache.
 *
 * WHY interface: Avoids circular imports. The actual EntityCache class
 * implements these methods.
 */
interface EntityCacheAdapter {
    addEntity(input: { id: string; model: string; parent: string | null; pathname: string }): void;
    updateEntity(id: string, changes: { pathname?: string; parent?: string | null }): void;
    removeEntity(id: string): void;
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default EntityCacheSync;
