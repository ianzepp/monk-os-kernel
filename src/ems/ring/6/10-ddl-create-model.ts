/**
 * DdlCreateModel Observer - Ring 6 DDL
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DdlCreateModel is a Ring 6 observer that creates a new database table
 * when a record is inserted into the 'models' table. This enables dynamic
 * schema creation - adding a model creates its backing table automatically.
 *
 * Ring 6 runs AFTER Ring 5 (database), meaning the model record has already
 * been inserted into the 'models' table before this observer runs. This
 * ensures the model metadata exists before the table is created.
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll('models', { model_name: 'invoices', ... })
 *     │
 * Ring 0-4: Validation, transformation
 *     │
 * Ring 5: INSERT INTO models (...) ◄── model record now exists
 *     │
 * Ring 6 (this): ──► CREATE TABLE IF NOT EXISTS invoices (...)
 *     │
 * Ring 7-9: Audit, cache invalidation
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Only runs for 'create' operation on 'models' table
 * INV-2: Uses CREATE TABLE IF NOT EXISTS (idempotent)
 * INV-3: Creates standard system columns (id, created_at, updated_at, trashed_at, expired_at)
 *
 * @module model/ring/6/ddl-create-model
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// DDL CREATE MODEL OBSERVER
// =============================================================================

/**
 * Creates table for new model.
 *
 * WHY priority 10: DDL should run early in Ring 6 so subsequent observers
 * (like index creation) can operate on the new table.
 */
export class DdlCreateModel extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'DdlCreateModel';

    /**
     * Ring 6 = Post-database operations.
     */
    readonly ring = ObserverRing.PostDatabase;

    /**
     * Priority 10 = early in ring.
     */
    readonly priority = 10;

    /**
     * Only handles create operations.
     */
    readonly operations: readonly OperationType[] = ['create'];

    /**
     * Only runs for the 'models' table.
     */
    override readonly models: readonly string[] = ['models'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Create table for new model.
     *
     * ALGORITHM:
     * 1. Get model_name from the record being created
     * 2. Build CREATE TABLE statement with system columns
     * 3. Execute DDL via system.db.exec()
     *
     * WHY CREATE TABLE IF NOT EXISTS: Idempotent - if table already exists
     * (e.g., from a previous failed transaction that was retried), we don't
     * fail. The table structure is what matters, not whether we created it.
     *
     * @param context - Observer context with record containing model_name
     * @throws EOBSSYS on DDL execution failure
     */
    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        const modelName = record.get('model_name') as string;

        if (!modelName) {
            throw new EOBSSYS('Cannot create table: model_name is missing');
        }

        // Build CREATE TABLE with system columns using dialect
        // All user-defined columns are added later via DdlCreateField
        const sql = system.db.dialect.createTable(modelName);

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            throw new EOBSSYS(
                `CREATE TABLE failed for '${modelName}': ${message}`,
            );
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default DdlCreateModel;
