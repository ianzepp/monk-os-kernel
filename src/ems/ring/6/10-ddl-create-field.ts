/**
 * DdlCreateField Observer - Base Class
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * DdlCreateFieldBase is the abstract base for Ring 6 observers that add
 * columns to existing tables when a record is inserted into the 'fields' table.
 *
 * Dialect-specific implementations (SQLite, PostgreSQL) extend this class
 * and provide mapType() and isDuplicateColumnError() methods.
 *
 * Ring 6 runs AFTER Ring 5 (database), meaning the field record has already
 * been inserted into the 'fields' table before this observer runs.
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * DatabaseOps.createAll('fields', { model_name: 'invoices', field_name: 'amount', type: 'numeric' })
 *     |
 * Ring 0-4: Validation, transformation
 *     |
 * Ring 5: INSERT INTO fields (...) <-- field record now exists
 *     |
 * Ring 6 (this): --> ALTER TABLE invoices ADD COLUMN amount REAL
 *     |
 * Ring 7-9: Audit, cache invalidation
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Only runs for 'create' operation on 'fields' table
 * INV-2: Silently ignores "column already exists" errors (idempotent)
 * INV-3: Type mapping is dialect-specific
 *
 * @module ems/ring/6/ddl-create-field
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// BASE CLASS
// =============================================================================

/**
 * Abstract base for column creation observers.
 *
 * WHY abstract: Type mapping and error detection differ between dialects.
 * Subclasses implement mapType() and isDuplicateColumnError().
 *
 * WHY priority 10: Same as DdlCreateModel - DDL should run early in Ring 6.
 */
export abstract class DdlCreateFieldBase extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    abstract override readonly name: string;
    abstract override readonly dialect: 'sqlite' | 'postgres';

    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];

    /**
     * Only runs for the 'fields' table.
     */
    override readonly models: readonly string[] = ['fields'];

    // =========================================================================
    // ABSTRACT METHODS
    // =========================================================================

    /**
     * Map abstract field type to dialect-specific SQL type.
     *
     * @param type - Abstract type (text, integer, numeric, boolean, etc.)
     * @returns SQL type string for this dialect
     */
    protected abstract mapType(type: string): string;

    /**
     * Check if error message indicates duplicate column.
     *
     * @param message - Error message from database
     * @returns true if this is a "column already exists" error
     */
    protected abstract isDuplicateColumnError(message: string): boolean;

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Add column for new field.
     *
     * ALGORITHM:
     * 1. Get model_name, field_name, type from record
     * 2. Map type to dialect-specific SQL type
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

        // Convert model name to valid table name
        const tableName = modelName.replace(/\./g, '_');
        const sqlType = this.mapType(fieldType);
        const sql = `ALTER TABLE ${tableName} ADD COLUMN ${fieldName} ${sqlType}`;

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Ignore "duplicate column" errors - column already exists
            if (this.isDuplicateColumnError(message)) {
                return;
            }

            throw new EOBSSYS(
                `ALTER TABLE ADD COLUMN failed for '${modelName}.${fieldName}': ${message}`,
            );
        }
    }
}

// =============================================================================
// RE-EXPORTS FOR BACKWARDS COMPATIBILITY
// =============================================================================

export { DdlCreateFieldSqlite } from './10-ddl-create-field.sqlite.js';
export { DdlCreateFieldPostgres } from './10-ddl-create-field.postgres.js';
