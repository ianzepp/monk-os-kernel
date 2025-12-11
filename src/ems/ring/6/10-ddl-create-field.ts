/**
 * DdlCreateField Observer - Ring 6 ALTER TABLE ADD COLUMN
 *
 * Adds a column to an existing table when a record is inserted into the
 * 'fields' table. Runs in Ring 6 (Post-Database) after the field metadata
 * has been persisted.
 *
 * Uses the DatabaseDialect from context to generate dialect-appropriate DDL:
 * - SQLite: TEXT/INTEGER/REAL/BLOB type affinity
 * - PostgreSQL: Native types (BOOLEAN, TIMESTAMPTZ, JSONB, etc.)
 *
 * @module ems/ring/6/ddl-create-field
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

// =============================================================================
// DDL CREATE FIELD OBSERVER
// =============================================================================

/**
 * Adds database column for new fields.
 *
 * When a record is inserted into the 'fields' table, this observer adds
 * the corresponding column to the model's table.
 */
export class DdlCreateField extends BaseObserver {
    readonly name = 'DdlCreateField';
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];
    override readonly models: readonly string[] = ['fields'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { dialect } = system;

        const modelName = record.get('model_name') as string;
        const fieldName = record.get('field_name') as string;
        const fieldType = record.get('type') as string;

        if (!modelName || !fieldName) {
            throw new EOBSSYS('Cannot add column: model_name or field_name is missing');
        }

        const tableName = modelName.replace(/\./g, '_');

        // Use dialect to generate ALTER TABLE with appropriate type
        const sql = dialect.addColumn(tableName, fieldName, fieldType);

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Ignore "column already exists" errors (both dialects)
            // SQLite: "duplicate column name"
            // PostgreSQL: "column ... already exists"
            if (message.includes('duplicate column') || message.includes('already exists')) {
                return;
            }

            throw new EOBSSYS(`ALTER TABLE ADD COLUMN failed for '${modelName}.${fieldName}': ${message}`);
        }
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default DdlCreateField;
