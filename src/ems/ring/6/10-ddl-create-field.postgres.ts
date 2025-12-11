/**
 * DdlCreateFieldPostgres Observer
 *
 * Adds a column to an existing PostgreSQL table when a record is inserted into
 * the 'fields' table. Runs in Ring 6 (Post-Database) after the field metadata
 * has been persisted.
 *
 * POSTGRESQL TYPE MAPPING
 * =======================
 * PostgreSQL has strict typing with native support for:
 * - BOOLEAN for true/false
 * - TIMESTAMPTZ for timezone-aware timestamps
 * - JSONB for binary JSON with indexing
 * - BYTEA for binary data
 *
 * @module ems/ring/6/ddl-create-field-postgres
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

export class DdlCreateFieldPostgres extends BaseObserver {
    readonly name = 'DdlCreateFieldPostgres';
    override readonly dialect = 'postgres' as const;
    readonly ring = ObserverRing.PostDatabase;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];
    override readonly models: readonly string[] = ['fields'];

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const modelName = record.get('model_name') as string;
        const fieldName = record.get('field_name') as string;
        const fieldType = record.get('type') as string;

        if (!modelName || !fieldName) {
            throw new EOBSSYS('Cannot add column: model_name or field_name is missing');
        }

        const tableName = modelName.replace(/\./g, '_');
        const sqlType = this.mapType(fieldType);
        const sql = `ALTER TABLE ${tableName} ADD COLUMN ${fieldName} ${sqlType}`;

        try {
            await system.db.exec(sql);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Ignore "column already exists" errors
            if (message.includes('already exists')) {
                return;
            }

            throw new EOBSSYS(`ALTER TABLE ADD COLUMN failed for '${modelName}.${fieldName}': ${message}`);
        }
    }

    /**
     * Map field type to PostgreSQL type.
     */
    private mapType(type: string): string {
        switch (type) {
            case 'integer':
                return 'INTEGER';
            case 'numeric':
                return 'NUMERIC';
            case 'boolean':
                return 'BOOLEAN';
            case 'binary':
                return 'BYTEA';
            case 'timestamp':
                return 'TIMESTAMPTZ';
            case 'date':
                return 'DATE';
            case 'jsonb':
                return 'JSONB';
            case 'uuid':
            case 'text':
            default:
                return 'TEXT';
        }
    }
}

export default DdlCreateFieldPostgres;
