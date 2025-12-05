/**
 * Tracked Observer - Ring 7 Audit
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Tracked is the audit observer in Ring 7, responsible for recording changes
 * to fields marked with `tracked=1` in the fields table. It creates a complete
 * history of changes for compliance, debugging, and undo operations.
 *
 * Ring 7 runs AFTER database operations (Ring 5), ensuring we only audit
 * changes that were successfully persisted.
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.updateAll('invoice', [{ id: '123', amount: 100 }])
 *     │
 * Ring 5: UPDATE invoice SET amount = 100 WHERE id = '123' (success)
 *     │
 * Ring 6: (DDL if needed)
 *     │
 * Ring 7 (this): ──► Check if 'amount' is tracked
 *     │              If tracked: INSERT INTO tracked (change record)
 *     │
 * Ring 8: Cache invalidation
 * ```
 *
 * WHY RING 7
 * ==========
 * Audit must run AFTER database operations because:
 * - We only want to audit successful changes
 * - Ring 5 may modify the record (e.g., auto-generated fields)
 * - Audit should see final state, not intermediate state
 *
 * TRACKED TABLE SCHEMA
 * ====================
 * ```sql
 * CREATE TABLE tracked (
 *     id          TEXT PRIMARY KEY,
 *     change_id   INTEGER,      -- Sequence per model_name+record_id
 *     model_name  TEXT NOT NULL,
 *     record_id   TEXT NOT NULL,
 *     operation   TEXT NOT NULL, -- 'create', 'update', 'delete'
 *     changes     TEXT NOT NULL, -- JSON: { field: { old, new } }
 *     created_by  TEXT,
 *     request_id  TEXT,
 *     metadata    TEXT
 * );
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Only audits fields with tracked=1 in fields table
 * INV-2: Skips if model has no tracked fields
 * INV-3: Skips if no tracked fields were changed
 * INV-4: change_id is monotonically increasing per model_name+record_id
 * INV-5: Changes stored as JSON for flexible schema
 *
 * CONCURRENCY MODEL
 * =================
 * Database write is atomic. change_id calculation uses MAX+1 pattern which
 * could have race conditions under concurrent updates to the same record.
 * For production use, consider:
 * - RETURNING clause with ON CONFLICT
 * - Separate sequence table
 * - Database-generated auto-increment per partition
 *
 * MEMORY MANAGEMENT
 * =================
 * Observer is stateless. Only allocates temporary objects for:
 * - Filtered diff (small: only tracked fields that changed)
 * - SQL parameters array
 * - JSON string for changes
 *
 * @module model/ring/7/tracked
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';

// =============================================================================
// TRACKED OBSERVER
// =============================================================================

/**
 * Records changes to tracked fields in the audit table.
 *
 * WHY priority 60: After DDL (Ring 6) but before other Ring 7 observers.
 * Audit is a core system function that should run early in the ring.
 *
 * WHY all operations: CREATE records initial values, UPDATE records changes,
 * DELETE records final state before removal.
 */
export class Tracked extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'Tracked';

    /**
     * Ring 7 = Audit.
     *
     * WHY: Must run after Ring 5 (Database) to only audit successful changes.
     * Must run after Ring 6 (DDL) to ensure schema changes are committed.
     */
    readonly ring = ObserverRing.Audit;

    /**
     * Priority 60 = early in ring.
     *
     * WHY 60: Audit is a fundamental operation that should capture changes
     * before other Ring 7 observers might modify context or state.
     */
    readonly priority = 60;

    /**
     * Runs for all operations.
     *
     * WHY create: Record initial values for tracked fields.
     * WHY update: Record old/new values for changed tracked fields.
     * WHY delete: Record final state before soft-delete.
     */
    readonly operations: readonly OperationType[] = ['create', 'update', 'delete'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Record changes to tracked fields.
     *
     * ALGORITHM:
     * 1. Get set of tracked fields from model
     * 2. Early return if no tracked fields
     * 3. Get diff filtered to tracked fields
     * 4. Early return if no tracked fields changed
     * 5. Calculate next change_id for this record
     * 6. Insert audit record
     *
     * WHY getDiffForFields: More efficient than getting full diff and filtering.
     * The model knows which fields are tracked, so we filter at source.
     *
     * WHY separate change_id query: Ensures monotonic sequence per record.
     * Alternative approaches (triggers, sequences) are database-specific.
     *
     * @param context - Observer context with record and system access
     */
    async execute(context: ObserverContext): Promise<void> {
        const { system, model, record, operation } = context;

        // STEP 1: Get tracked fields for this model
        // WHY from model: Cached in Model instance, no database query
        const trackedFields = model.getTrackedFields();

        // STEP 2: Early return if no tracked fields
        // WHY check size: Most models don't have tracked fields
        if (trackedFields.size === 0) {
            return;
        }

        // STEP 3: Get diff filtered to tracked fields
        // WHY getDiffForFields: Only allocates objects for tracked fields
        const diff = record.getDiffForFields(trackedFields);

        // STEP 4: Early return if no tracked fields changed
        // WHY check keys: Update might only change non-tracked fields
        const changedFields = Object.keys(diff);

        if (changedFields.length === 0) {
            return;
        }

        // STEP 5: Get record ID
        // WHY get('id'): For new records, id was set in earlier ring
        const recordId = record.get('id') as string;

        if (!recordId) {
            // DEFENSIVE: Should never happen if pipeline is correct
            return;
        }

        // STEP 6: Calculate next change_id
        // WHY MAX+1: Ensures monotonic sequence per model_name+record_id
        // WHY COALESCE: First change for this record starts at 1
        const changeIdSql = `
            SELECT COALESCE(MAX(change_id), 0) + 1 as next_id
            FROM tracked
            WHERE model_name = ? AND record_id = ?
        `;
        const changeIdResult = await system.db.query<{ next_id: number }>(
            changeIdSql,
            [model.modelName, recordId],
        );
        const changeId = changeIdResult[0]?.next_id ?? 1;

        // STEP 7: Generate audit record ID
        // WHY hex randomblob: Matches schema.sql pattern for SQLite
        const id = crypto.randomUUID().replace(/-/g, '');

        // STEP 8: Insert audit record
        // WHY JSON.stringify: Schema stores changes as TEXT (JSON)
        const insertSql = `
            INSERT INTO tracked (id, change_id, model_name, record_id, operation, changes)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        await system.db.execute(insertSql, [
            id,
            changeId,
            model.modelName,
            recordId,
            operation,
            JSON.stringify(diff),
        ]);
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default Tracked;
