/**
 * DdlCreateFieldSqlite Observer
 *
 * Adds a column to an existing SQLite table when a record is inserted into
 * the 'fields' table. Runs in Ring 6 (Post-Database) after the field metadata
 * has been persisted.
 *
 * SQLITE TYPE MAPPING
 * ===================
 * SQLite has flexible typing (type affinity):
 * - TEXT for strings, dates, UUIDs, JSON
 * - INTEGER for integers and booleans (0/1)
 * - REAL for decimals
 * - BLOB for binary data
 *
 * @module ems/ring/6/ddl-create-field-sqlite
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSSYS } from '../../observers/errors.js';

export class DdlCreateFieldSqlite extends BaseObserver {
    readonly name = 'DdlCreateFieldSqlite';
    override readonly dialect = 'sqlite' as const;
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

            // Ignore "duplicate column" errors - column already exists
            if (message.includes('duplicate column')) {
                return;
            }

            throw new EOBSSYS(`ALTER TABLE ADD COLUMN failed for '${modelName}.${fieldName}': ${message}`);
        }
    }

    /**
     * Map field type to SQLite type affinity.
     */
    private mapType(type: string): string {
        switch (type) {
            case 'integer':
                return 'INTEGER';
            case 'numeric':
                return 'REAL';
            case 'boolean':
                return 'INTEGER';
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

export default DdlCreateFieldSqlite;
