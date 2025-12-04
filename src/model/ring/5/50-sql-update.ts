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
     * For entity models (file, folder, device, proc, link, temp):
     * 1. Split changes into entity fields (parent, pathname) and detail fields
     * 2. Begin transaction if both need updating
     * 3. UPDATE entities table for hierarchy changes
     * 4. UPDATE detail table for model-specific changes
     * 5. Commit transaction
     *
     * For meta-models (models, fields, tracked):
     * 1. UPDATE directly (no entities table involvement)
     *
     * @param context - Observer context with model, record, and system services
     * @throws EOBSSYS on database execution failure
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model, record, system } = context;

        const changes = record.toChanges();
        const id = record.get('id') as string;

        // EARLY EXIT: No changes to apply
        if (Object.keys(changes).length === 0) {
            return;
        }

        // Meta-models don't use entities table
        if (META_MODELS.has(model.modelName)) {
            await this.updateDirect(system.db, model.modelName, id, changes);
            return;
        }

        // Split changes into entity vs detail fields
        const entityChanges: Record<string, unknown> = {};
        const detailChanges: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(changes)) {
            if (ENTITY_FIELDS.has(key)) {
                entityChanges[key] = value;
            } else {
                detailChanges[key] = value;
            }
        }

        const hasEntityChanges = Object.keys(entityChanges).length > 0;
        const hasDetailChanges = Object.keys(detailChanges).length > 0;

        // If both need updating, use transaction
        if (hasEntityChanges && hasDetailChanges) {
            try {
                await system.db.execute('BEGIN IMMEDIATE');
                try {
                    await this.updateTable(system.db, 'entities', id, entityChanges);
                    await this.updateTable(system.db, model.modelName, id, detailChanges);
                    await system.db.execute('COMMIT');
                } catch (err) {
                    await system.db.execute('ROLLBACK');
                    throw err;
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new EOBSSYS(`UPDATE failed for ${model.modelName}[${id}]: ${message}`);
            }
        } else if (hasEntityChanges) {
            await this.updateTable(system.db, 'entities', id, entityChanges);
        } else if (hasDetailChanges) {
            await this.updateTable(system.db, model.modelName, id, detailChanges);
        }
    }

    /**
     * Update directly in a table (for meta-models).
     */
    private async updateDirect(
        db: ObserverContext['system']['db'],
        tableName: string,
        id: string,
        changes: Record<string, unknown>
    ): Promise<void> {
        await this.updateTable(db, tableName, id, changes);
    }

    /**
     * Execute UPDATE on a specific table.
     */
    private async updateTable(
        db: ObserverContext['system']['db'],
        tableName: string,
        id: string,
        changes: Record<string, unknown>
    ): Promise<void> {
        const columns = Object.keys(changes);
        if (columns.length === 0) return;

        const setClauses = columns.map((col) => `${col} = ?`).join(', ');
        const values = columns.map((col) => changes[col]);
        values.push(id);

        const sql = `UPDATE ${tableName} SET ${setClauses} WHERE id = ?`;

        try {
            await db.execute(sql, values);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new EOBSSYS(`UPDATE failed for ${tableName}[${id}]: ${message}`);
        }
    }
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Meta-models that don't use the entities table.
 */
const META_MODELS = new Set(['models', 'fields', 'tracked']);

/**
 * Fields that belong in the entities table.
 * Note: timestamps go to detail tables, not entities.
 */
const ENTITY_FIELDS = new Set([
    'parent',
    'pathname',
]);

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default SqlUpdate;
