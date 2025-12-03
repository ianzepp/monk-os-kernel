/**
 * Cache Observer - Ring 8 Integration
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Cache is a Ring 8 observer that invalidates cached model metadata when
 * records in the 'models' or 'fields' tables are modified. This ensures
 * the ModelCache always reflects the current database state.
 *
 * Ring 8 runs AFTER Ring 6 (DDL), meaning schema changes have already been
 * applied before the cache is invalidated. This ordering ensures:
 * 1. Model/field record is persisted (Ring 5)
 * 2. Table/column is created (Ring 6)
 * 3. Cache is invalidated (Ring 8)
 * 4. Next cache access reloads fresh metadata
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll('fields', { model_name: 'invoice', field_name: 'amount', ... })
 *     │
 * Ring 5: INSERT INTO fields (...) ◄── field record persisted
 *     │
 * Ring 6: ALTER TABLE invoice ADD COLUMN amount ◄── column created
 *     │
 * Ring 8 (this): ──► cache.invalidate('invoice') ◄── cache cleared
 *     │
 * Next cache.get('invoice'): ──► reloads from database with new field
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Only runs for 'models' and 'fields' tables (enforced by models filter)
 * INV-2: Invalidates the target model (model_name field), not the meta-table
 * INV-3: Runs for all mutation operations (create, update, delete)
 * INV-4: model_name field must exist on all filtered tables
 *
 * CONCURRENCY MODEL
 * =================
 * This observer is synchronous - cache.invalidate() is a Map.delete() call.
 * No await points means no interleaving within this observer.
 *
 * However, between cache invalidation and subsequent cache read, another
 * operation could modify the same model. This is acceptable because:
 * - Each pipeline run is independent
 * - Cache reads always get consistent snapshots from database
 * - Worst case: extra cache miss, not stale data
 *
 * MEMORY MANAGEMENT
 * =================
 * Observer is stateless. Cache entry removal frees the Model object and its
 * field metadata arrays for garbage collection.
 *
 * @module model/ring/8/cache
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

// =============================================================================
// CACHE OBSERVER
// =============================================================================

/**
 * Invalidates model cache after model/field changes.
 *
 * WHY priority 50: Middle of Ring 8. No ordering dependencies within
 * the integration ring for this observer. Other Ring 8 observers (webhooks,
 * event emitters) can run before or after without affecting correctness.
 *
 * WHY Ring 8 not Ring 6: DDL operations in Ring 6 might need cache access
 * to determine column types. Invalidating too early would cause unnecessary
 * cache misses during the same pipeline run.
 */
export class Cache extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'Cache';

    /**
     * Ring 8 = Integration.
     *
     * WHY: Post-database operations that integrate with external systems
     * or maintain derived state (like caches).
     */
    readonly ring = ObserverRing.Integration;

    /**
     * Priority 50 = middle of ring.
     *
     * WHY 50: No dependencies on other Ring 8 observers. Using middle
     * priority leaves room for observers that must run before (10-40)
     * or after (60-90) cache invalidation.
     */
    readonly priority = 50;

    /**
     * Invalidates on all mutation operations.
     *
     * WHY all three:
     * - create: New model/field added to metadata
     * - update: Model/field properties changed (e.g., frozen flag)
     * - delete: Model/field removed (soft delete via trashed_at)
     */
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];

    /**
     * Only runs for meta-tables that affect model definitions.
     *
     * WHY explicit list: Most tables don't affect model metadata.
     * Only 'models' and 'fields' tables define the schema.
     *
     * INVARIANT: All tables in this list must have a 'model_name' column.
     */
    override readonly models: readonly string[] = ['models', 'fields'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Invalidate cache for the affected model.
     *
     * ALGORITHM:
     * 1. Extract model_name from record (identifies which model's cache to clear)
     * 2. Guard against missing model_name (defensive, shouldn't happen)
     * 3. Call cache.invalidate() - synchronous Map.delete()
     * 4. Return - next cache.get() will reload from database
     *
     * WHY model_name not modelName: The record contains database column names
     * (snake_case), not the Model wrapper's camelCase properties. The Model
     * class provides camelCase getters, but ModelRecord uses raw column names.
     *
     * WHY no error on missing model_name: This is defensive programming.
     * The 'models' and 'fields' tables both have model_name as a required
     * field, so this should never happen. Silent skip prevents pipeline
     * failure for a non-critical operation.
     *
     * @param context - Observer context with record containing model_name
     */
    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        // Extract target model name from record
        // Both 'models' and 'fields' tables have this column
        const targetModel = record.get('model_name') as string;

        // DEFENSIVE: Skip if model_name is somehow missing
        // This shouldn't happen but prevents cascade failures
        if (!targetModel) {
            return;
        }

        // Invalidate cache entry
        // SYNC: Map.delete() is synchronous, no race conditions
        // IDEMPOTENT: Safe to call even if model not cached
        system.cache.invalidate(targetModel);
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default Cache;
