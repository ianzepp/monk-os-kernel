/**
 * SqlDelete Observer - Ring 5 Soft Delete Execution
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * SqlDelete is the Ring 5 observer responsible for soft-deleting records.
 * Rather than executing a DELETE statement, it updates the `trashed_at`
 * timestamp to mark the record as deleted while preserving the data.
 *
 * Soft delete enables:
 * - Recovery (revert operation clears trashed_at)
 * - Audit trail (record history preserved)
 * - Referential integrity (foreign keys not broken)
 *
 * Hard delete (actual DELETE) is handled separately by expireAll() in
 * DatabaseOps, which is used for permanent data removal.
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.deleteAll():
 *   └── Creates ModelRecord with trashed_at = now
 *        │
 * Ring 0-4: Validation (can block deletion)
 *        │
 * Ring 5 (this): ──► UPDATE {table} SET trashed_at = ? WHERE id = ?
 *        │
 * Ring 6-9: Audit tracks deletion
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Record must have an id
 * INV-2: trashed_at is set by DatabaseOps before observer pipeline
 * INV-3: Soft delete is UPDATE, not DELETE (data preserved)
 * INV-4: trashed_at = null indicates active record
 *
 * CONCURRENCY MODEL
 * =================
 * Soft delete is an UPDATE, same concurrency model as SqlUpdate.
 * Concurrent deletes of the same record are idempotent (second one
 * just updates trashed_at again).
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Record already soft-deleted
 *       FIX: UPDATE still succeeds, just updates trashed_at again.
 *       Idempotent behavior is acceptable.
 * RC-2: Record hard-deleted (expired) between load and soft-delete
 *       FIX: UPDATE affects 0 rows. Not treated as error because
 *       the intent (record should not be active) is achieved.
 *
 * @module model/ring/5/sql-delete
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// SQL DELETE OBSERVER
// =============================================================================

/**
 * Executes soft DELETE (sets trashed_at) for records.
 *
 * WHY soft delete: Preserves data for recovery and audit. Hard delete
 * (expireAll) is a separate, explicit operation for permanent removal.
 *
 * TESTABILITY: Uses DatabaseConnection via context, enabling mock injection.
 */
export class SqlDelete extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'SqlDelete';

    /**
     * Ring 5 = Database operations.
     */
    readonly ring = ObserverRing.Database;

    /**
     * Priority 50 = middle of ring.
     */
    readonly priority = 50;

    /**
     * Only handles 'delete' operations.
     *
     * NOTE: This is soft delete. The 'delete' operation type is reused
     * for both soft and hard delete; the difference is in how DatabaseOps
     * calls the pipeline (deleteAll vs expireAll).
     */
    readonly operations: readonly OperationType[] = ['delete'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Execute soft DELETE (UPDATE trashed_at).
     *
     * ALGORITHM:
     * For entity models: UPDATE detail table's trashed_at (entities has no timestamps)
     * For meta-models: UPDATE that table directly
     *
     * WHY detail table only: The entities table is purely for identity + path
     * resolution. Timestamps (including trashed_at) live in detail tables.
     * Trashing an entity doesn't require cache invalidation - the cache
     * contains all entities, and the detail table query filters on trashed_at.
     *
     * @param context - Observer context with model, record, and system services
     * @throws EOBSSYS on database execution failure
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model, record, system } = context;

        const id = record.get('id') as string;
        const trashedAt = record.get('trashed_at');

        // For both entity models and meta-models, update the model's table directly
        // (Entity models have trashed_at in detail table, not entities table)
        const sql = `UPDATE ${model.modelName} SET trashed_at = ? WHERE id = ?`;

        try {
            await system.db.execute(sql, [trashedAt, id]);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            throw new EOBSSYS(
                `DELETE (soft) failed for ${model.modelName}[${id}]: ${message}`,
            );
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default SqlDelete;
