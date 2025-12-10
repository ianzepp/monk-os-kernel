/**
 * DdlCreateField Observer - SQLite Implementation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Adds a column to an existing SQLite table when a record is inserted into
 * the 'fields' table. This is the SQLite-specific implementation.
 *
 * See 10-ddl-create-field.ts for the base class with shared documentation.
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

import { DdlCreateFieldBase } from './10-ddl-create-field.js';

// =============================================================================
// SQLITE IMPLEMENTATION
// =============================================================================

/**
 * SQLite-specific DDL for column creation.
 */
export class DdlCreateFieldSqlite extends DdlCreateFieldBase {
    readonly name = 'DdlCreateFieldSqlite';
    readonly dialect = 'sqlite' as const;

    /**
     * Map field type to SQLite type affinity.
     *
     * WHY type affinity: SQLite doesn't enforce types strictly.
     * Any column can hold any value, but affinity determines
     * storage preference and comparison behavior.
     */
    protected mapType(type: string): string {
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

    /**
     * Detect duplicate column error from SQLite.
     */
    protected isDuplicateColumnError(message: string): boolean {
        return message.includes('duplicate column');
    }
}

export default DdlCreateFieldSqlite;
