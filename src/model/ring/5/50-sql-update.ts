/**
 * SqlUpdate Observer - Ring 5 UPDATE Execution
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * SqlUpdate is the Ring 5 observer responsible for executing UPDATE statements.
 * It transforms the validated and enriched ModelRecord changes into a SQL
 * UPDATE statement, targeting only the columns that have changed.
 *
 * Unlike INSERT (which writes all columns), UPDATE is selective:
 * - Only columns in ModelRecord.toChanges() are included in SET clause
 * - If no changes remain after validation, UPDATE is skipped (no-op)
 * - Record identity is preserved (id cannot change)
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * Ring 0: UpdateMerger applies defaults
 * Ring 1-4: Validation, transformation → ModelRecord.toChanges()
 *                                              │
 *                                              ▼
 * Ring 5 (this): ─────────────────────► UPDATE {table} SET ... WHERE id = ?
 *                                              │
 *                                              ▼
 * Ring 6-9: Post-processing (audit tracks changes)
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Record must have an id (updates without id are rejected earlier)
 * INV-2: Only changed fields are included in SET clause
 * INV-3: updated_at is always included in changes (set by DatabaseOps)
 * INV-4: Empty changes result in no-op (no SQL executed)
 *
 * CONCURRENCY MODEL
 * =================
 * Each UPDATE is atomic at the database level. No cross-record transaction
 * boundaries. Concurrent updates to the same record are serialized by SQLite.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Record deleted between load and update
 *       FIX: UPDATE WHERE id = ? affects 0 rows - we don't treat this as error
 *       (soft delete means record still exists in database)
 * RC-2: Concurrent update changes same field
 *       FIX: Last-write-wins at database level. Tracked table in Ring 7
 *       records both changes for audit trail.
 *
 * @module model/ring/5/sql-update
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// SQL UPDATE OBSERVER
// =============================================================================

/**
 * Executes UPDATE statement for modified records.
 *
 * TESTABILITY: Uses DatabaseConnection via context, enabling mock injection.
 */
export class SqlUpdate extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'SqlUpdate';

    /**
     * Ring 5 = Database operations.
     */
    readonly ring = ObserverRing.Database;

    /**
     * Priority 50 = middle of ring.
     */
    readonly priority = 50;

    /**
     * Only handles 'update' operations.
     */
    readonly operations: readonly OperationType[] = ['update'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Execute UPDATE statement.
     *
     * ALGORITHM:
     * 1. Get only changed fields from ModelRecord
     * 2. If no changes, skip (no-op)
     * 3. Build SET clauses for each changed field
     * 4. Execute UPDATE WHERE id = ?
     * 5. Wrap any database errors in EOBSSYS
     *
     * WHY check for empty changes: Ring 0-4 observers may strip or reject
     * all changes (e.g., all fields were immutable). Rather than error,
     * we treat this as a successful no-op.
     *
     * @param context - Observer context with model, record, and system services
     * @throws EOBSSYS on database execution failure
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model, record, system } = context;

        // Get only the changes (not the full merged record)
        const changes = record.toChanges();
        const id = record.get('id') as string;

        // Build SET clauses
        const columns = Object.keys(changes);

        // EARLY EXIT: No changes to apply
        // WHY: Validation rings may have stripped all changes (e.g., immutable fields).
        // This is not an error - it's a valid no-op.
        if (columns.length === 0) {
            return;
        }

        const setClauses = columns.map((col) => `${col} = ?`).join(', ');
        const values = columns.map((col) => changes[col]);

        // Add id as the WHERE parameter (always last)
        values.push(id);

        // SAFETY: Table/column names from validated metadata, values parameterized.
        const sql = `UPDATE ${model.modelName} SET ${setClauses} WHERE id = ?`;

        try {
            await system.db.execute(sql, values);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            throw new EOBSSYS(
                `UPDATE failed for ${model.modelName}[${id}]: ${message}`
            );
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default SqlUpdate;
