/**
 * DdlCreateModel Observer - PostgreSQL Implementation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Creates a new PostgreSQL table when a record is inserted into the 'models' table.
 * This is the PostgreSQL-specific implementation that generates PostgreSQL DDL syntax.
 *
 * See 10-ddl-create-model.ts for the base class with shared documentation.
 *
 * POSTGRESQL-SPECIFIC DDL
 * =======================
 * - UUID: gen_random_uuid()::text
 * - Timestamps: TIMESTAMPTZ with now() default
 * - Booleans: native BOOLEAN type
 *
 * @module ems/ring/6/ddl-create-model-postgres
 */

import { DdlCreateModelBase } from './10-ddl-create-model.js';

// =============================================================================
// POSTGRESQL IMPLEMENTATION
// =============================================================================

/**
 * PostgreSQL-specific DDL for model table creation.
 */
export class DdlCreateModelPostgres extends DdlCreateModelBase {
    readonly name = 'DdlCreateModelPostgres';
    readonly dialect = 'postgres' as const;

    /**
     * Build PostgreSQL CREATE TABLE statement.
     *
     * WHY TIMESTAMPTZ: Stores timezone-aware timestamps, avoids
     * ambiguity when servers are in different timezones.
     *
     * WHY gen_random_uuid()::text: Generates UUID and casts to text
     * for consistency with the id column type.
     */
    protected buildCreateTable(tableName: string): string {
        return `
            CREATE TABLE IF NOT EXISTS ${tableName} (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                created_at  TIMESTAMPTZ DEFAULT now(),
                updated_at  TIMESTAMPTZ DEFAULT now(),
                trashed_at  TIMESTAMPTZ,
                expired_at  TIMESTAMPTZ
            )
        `;
    }
}

export default DdlCreateModelPostgres;
