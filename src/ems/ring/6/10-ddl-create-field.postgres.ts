/**
 * DdlCreateField Observer - PostgreSQL Implementation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Adds a column to an existing PostgreSQL table when a record is inserted into
 * the 'fields' table. This is the PostgreSQL-specific implementation.
 *
 * See 10-ddl-create-field.ts for the base class with shared documentation.
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

import { DdlCreateFieldBase } from './10-ddl-create-field.js';

// =============================================================================
// POSTGRESQL IMPLEMENTATION
// =============================================================================

/**
 * PostgreSQL-specific DDL for column creation.
 */
export class DdlCreateFieldPostgres extends DdlCreateFieldBase {
    readonly name = 'DdlCreateFieldPostgres';
    readonly dialect = 'postgres' as const;

    /**
     * Map field type to PostgreSQL type.
     *
     * WHY native types: PostgreSQL enforces types strictly and provides
     * better performance/features with native types (e.g., JSONB indexing).
     */
    protected mapType(type: string): string {
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
                return 'TEXT'; // Keep as TEXT for consistency with id column
            case 'text':
            default:
                return 'TEXT';
        }
    }

    /**
     * Detect duplicate column error from PostgreSQL.
     */
    protected isDuplicateColumnError(message: string): boolean {
        return message.includes('already exists');
    }
}

export default DdlCreateFieldPostgres;
