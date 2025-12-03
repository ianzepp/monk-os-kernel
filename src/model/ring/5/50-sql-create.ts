/**
 * SqlCreate Observer - Ring 5 INSERT Execution
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * SqlCreate is the Ring 5 observer responsible for executing INSERT statements.
 * It transforms the validated and enriched ModelRecord (from Rings 0-4) into
 * a SQL INSERT statement and executes it via the DatabaseConnection.
 *
 * This observer is the persistence boundary - records that pass Ring 5 are
 * committed to the database. Prior rings can reject; post-database rings (6-9)
 * observe but cannot undo.
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * Ring 0-4: Validation, transformation → ModelRecord.toRecord()
 *                                              │
 *                                              ▼
 * Ring 5 (this): ─────────────────────► INSERT INTO {table} (...)
 *                                              │
 *                                              ▼
 * Ring 6-9: Post-processing (DDL, audit, cache) ◄── record committed
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Record must have an id before reaching this observer
 * INV-2: Record must have created_at and updated_at set
 * INV-3: SQL execution uses parameterized queries (no string interpolation of values)
 * INV-4: Database errors are wrapped in EOBSSYS for consistent error handling
 *
 * CONCURRENCY MODEL
 * =================
 * Each record is inserted independently. SQLite serializes writes internally
 * (WAL mode allows concurrent reads). No cross-record transaction boundaries
 * are enforced at this level - each INSERT is atomic unto itself.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Unique constraint violations (concurrent insert of same id)
 *       FIX: Let database reject, wrap in EOBSSYS with details
 * RC-2: Table doesn't exist (schema race during model creation)
 *       FIX: ModelDdlCreate runs in Ring 6 for 'models', so table exists
 *            for subsequent records. First record creation may fail if
 *            racing with model creation - caller should retry.
 *
 * @module model/ring/5/sql-create
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// SQL CREATE OBSERVER
// =============================================================================

/**
 * Executes INSERT statement for new records.
 *
 * TESTABILITY: Uses DatabaseConnection via context, enabling mock injection.
 * No direct database access outside of execute().
 */
export class SqlCreate extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * Observer name for debugging and metrics.
     */
    readonly name = 'SqlCreate';

    /**
     * Ring 5 = Database operations.
     *
     * WHY Ring 5: After validation (1), security (2), business logic (3),
     * and enrichment (4). Before post-database operations (6-9).
     */
    readonly ring = ObserverRing.Database;

    /**
     * Priority 50 = middle of ring.
     *
     * WHY 50: Leaves room for pre/post SQL hooks if needed later.
     * Convention: 10/20/30 for early, 50 for standard, 70/80/90 for late.
     */
    readonly priority = 50;

    /**
     * Only handles 'create' operations.
     *
     * WHY readonly tuple: Prevents accidental modification and enables
     * type narrowing in the observer runner's filter logic.
     */
    readonly operations: readonly OperationType[] = ['create'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Execute INSERT statement.
     *
     * ALGORITHM:
     * 1. Extract merged record data from ModelRecord
     * 2. Build column list and placeholder list
     * 3. Extract values in column order
     * 4. Execute parameterized INSERT
     * 5. Wrap any database errors in EOBSSYS
     *
     * RACE CONDITION NOTE:
     * If two concurrent creates race with the same id (unlikely with UUID
     * generation but possible with user-provided ids), the database's unique
     * constraint will reject one. We wrap this as EOBSSYS and let the
     * stream-level error handling decide what to do.
     *
     * @param context - Observer context with model, record, and system services
     * @throws EOBSSYS on database execution failure
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model, record, system } = context;

        // Get merged record (original + changes)
        const data = record.toRecord();

        // Build SQL components
        const columns = Object.keys(data);
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((col) => data[col]);

        // SAFETY: Table name comes from model metadata (validated at model load).
        // Column names come from record keys (validated by earlier rings).
        // Values are parameterized (no SQL injection risk).
        const sql = `INSERT INTO ${model.modelName} (${columns.join(', ')}) VALUES (${placeholders})`;

        try {
            await system.db.execute(sql, values);
        } catch (err) {
            // Wrap database errors with context for debugging
            const message = err instanceof Error ? err.message : String(err);
            const recordId = data.id ?? 'unknown';

            throw new EOBSSYS(
                `INSERT failed for ${model.modelName}[${recordId}]: ${message}`
            );
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default SqlCreate;
