/**
 * UpdateMerger Observer - Ring 0 Data Preparation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * UpdateMerger is the first observer in the pipeline (Ring 0), responsible for
 * preparing record data before validation and persistence. For UPDATE operations,
 * it ensures system fields like updated_at are properly set.
 *
 * Ring 0 runs BEFORE all other rings, meaning data is prepared before:
 * - Ring 1 validates constraints
 * - Ring 4 applies transforms
 * - Ring 5 executes SQL
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.updateAll('invoice', [{ id: '123', amount: 100 }])
 *     │
 * Ring 0 (this): ──► Ensure updated_at is set
 *     │              Record now has { id: '123', amount: 100, updated_at: '...' }
 *     │
 * Ring 1: Validate constraints (updated_at now present)
 *     │
 * Ring 5: UPDATE invoice SET amount = 100, updated_at = '...' WHERE id = '123'
 * ```
 *
 * WHY RING 0
 * ==========
 * Setting updated_at in Ring 0 rather than Ring 5 (SQL) ensures:
 * - Validation in Ring 1 sees the timestamp
 * - Transforms in Ring 4 can operate on it
 * - Audit in Ring 7 records the correct timestamp
 * - All observers see consistent data
 *
 * INVARIANTS
 * ==========
 * INV-1: Only runs for 'update' operations (create handles timestamps differently)
 * INV-2: updated_at is always set after this observer runs
 * INV-3: Does not overwrite updated_at if explicitly provided in input
 * INV-4: Timestamp uses ISO 8601 format for SQLite compatibility
 *
 * CONCURRENCY MODEL
 * =================
 * This observer is synchronous - all operations are Map.set() calls.
 * No await points means no interleaving within this observer.
 *
 * MEMORY MANAGEMENT
 * =================
 * Observer is stateless. Only modifies the ModelRecord's changes Map,
 * which is already allocated by the pipeline.
 *
 * @module model/ring/0/update-merger
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

// =============================================================================
// UPDATE MERGER OBSERVER
// =============================================================================

/**
 * Prepares record data for UPDATE operations.
 *
 * WHY priority 50: Middle of Ring 0. Leaves room for observers that must
 * run before (id generation at 10) or after (data normalization at 90).
 *
 * WHY only 'update': CREATE operations handle timestamps via database
 * defaults or explicit setting in DatabaseOps. DELETE operations set
 * trashed_at, not updated_at.
 */
export class UpdateMerger extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'UpdateMerger';

    /**
     * Ring 0 = Data Preparation.
     *
     * WHY: Data must be prepared before validation (Ring 1) can check it.
     * Setting updated_at here ensures validators see complete data.
     */
    readonly ring = ObserverRing.DataPreparation;

    /**
     * Priority 50 = middle of ring.
     *
     * WHY 50: No dependencies on other Ring 0 observers currently.
     * Middle priority allows future observers to run before or after.
     */
    readonly priority = 50;

    /**
     * Only runs for UPDATE operations.
     *
     * WHY not create: CREATE uses database defaults for created_at/updated_at.
     * WHY not delete: DELETE sets trashed_at, not updated_at.
     */
    readonly operations: readonly OperationType[] = ['update'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Prepare record data for UPDATE.
     *
     * ALGORITHM:
     * 1. Check if updated_at is already in the change set
     * 2. If not present, set to current ISO timestamp
     *
     * WHY check has() not get(): We only want to set updated_at if the user
     * didn't explicitly provide it. has() checks the change set specifically,
     * not the merged value (which would include original).
     *
     * WHY ISO 8601: SQLite stores TEXT for timestamps. ISO format ensures:
     * - Lexicographic sorting works correctly
     * - Human readable for debugging
     * - Standard format parseable by JavaScript Date
     *
     * @param context - Observer context with record to prepare
     */
    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;

        // DEFENSIVE: Only set updated_at if not explicitly provided
        // User may want to set a specific timestamp (e.g., import scenarios)
        if (!record.has('updated_at')) {
            // SYNC: record.set() is Map.set(), no async operations
            // ISO 8601 format: 2024-01-15T10:30:00.000Z
            record.set('updated_at', new Date().toISOString());
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default UpdateMerger;
