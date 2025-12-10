/**
 * DdlCreateField Observer - Ring 6 DDL
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DdlCreateField is a Ring 6 observer that adds a column to an existing
 * table when a record is inserted into the 'fields' table. This enables
 * dynamic schema evolution - adding a field adds its backing column.
 *
 * Ring 6 runs AFTER Ring 5 (database), meaning the field record has already
 * been inserted into the 'fields' table before this observer runs.
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll('fields', { model_name: 'invoices', field_name: 'amount', type: 'numeric' })
 *     │
 * Ring 0-4: Validation, transformation
 *     │
 * Ring 5: INSERT INTO fields (...) ◄── field record now exists
 *     │
 * Ring 6 (this): ──► ALTER TABLE invoices ADD COLUMN amount REAL
 *     │
 * Ring 7-9: Audit, cache invalidation
 * ```
 *
 * TYPE MAPPING
 * ============
 * - text, uuid, timestamp, date → TEXT
 * - integer → INTEGER
 * - numeric → REAL
 * - boolean → INTEGER (0/1)
 * - binary → BLOB
 * - jsonb → TEXT (JSON stored as text in SQLite)
 *
 * INVARIANTS
 * ==========
 * INV-1: Only runs for 'create' operation on 'fields' table
 * INV-2: Silently ignores "column already exists" errors (idempotent)
 * INV-3: Uses SQLite type affinity (TEXT, INTEGER, REAL, BLOB)
 *
 * @module model/ring/6/ddl-create-field
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// DDL CREATE FIELD OBSERVER
// =============================================================================

/**
 * Adds column for new field.
 *
 * WHY priority 10: Same as DdlCreateModel - DDL should run early in Ring 6.
 */
export class DdlCreateField extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'DdlCreateField';

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
     * Only runs for the 'fields' table.
     */
    override readonly models: readonly string[] = ['fields'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Add column for new field.
     *
     * ALGORITHM:
     * 1. Get model_name, field_name, type from record
     * 2. Map type to SQLite type affinity
     * 3. Execute ALTER TABLE ADD COLUMN
     * 4. Ignore "duplicate column" errors (idempotent)
     *
     * @param context - Observer context with record containing field metadata
     * @throws EOBSSYS on DDL execution failure (except duplicate column)
     */
    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;

        const modelName = record.get('model_name') as string;
        const fieldName = record.get('field_name') as string;
        const fieldType = record.get('type') as string;

        if (!modelName || !fieldName) {
            throw new EOBSSYS(
                `Cannot add column: model_name or field_name is missing`,
            );
        }

        // Convert model name to valid SQLite table name
        const tableName = modelName.replace(/\./g, '_');
        const sqlType = this.mapType(fieldType);
        const sql = `ALTER TABLE ${tableName} ADD COLUMN ${fieldName} ${sqlType}`;

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Ignore "duplicate column" errors - column already exists
            // SQLite error: "duplicate column name: X"
            if (message.includes('duplicate column')) {
                return;
            }

            throw new EOBSSYS(
                `ALTER TABLE ADD COLUMN failed for '${modelName}.${fieldName}': ${message}`,
            );
        }
    }

    // =========================================================================
    // TYPE MAPPING
    // =========================================================================

    /**
     * Map field type to SQLite type affinity.
     *
     * SQLite has flexible typing (type affinity), so we use:
     * - TEXT for strings, dates, UUIDs, JSON
     * - INTEGER for integers and booleans
     * - REAL for decimals
     * - BLOB for binary data
     */
    private mapType(type: string): string {
        switch (type) {
            case 'integer':
                return 'INTEGER';
            case 'numeric':
                return 'REAL';
            case 'boolean':
                return 'INTEGER'; // 0/1
            case 'binary':
                return 'BLOB';
            case 'text':
            case 'uuid':
            case 'timestamp':
            case 'date':
            case 'jsonb':
            default:
                return 'TEXT';
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default DdlCreateField;
