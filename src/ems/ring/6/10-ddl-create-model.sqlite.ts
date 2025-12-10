/**
 * DdlCreateModel Observer - SQLite Implementation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Creates a new SQLite table when a record is inserted into the 'models' table.
 * This is the SQLite-specific implementation that generates SQLite DDL syntax.
 *
 * See 10-ddl-create-model.ts for the base class with shared documentation.
 *
 * SQLITE-SPECIFIC DDL
 * ===================
 * - UUID: lower(hex(randomblob(16)))
 * - Timestamps: TEXT with datetime('now') default
 * - Booleans: INTEGER (0/1)
 *
 * @module ems/ring/6/ddl-create-model-sqlite
 */

import { DdlCreateModelBase } from './10-ddl-create-model.js';

// =============================================================================
// SQLITE IMPLEMENTATION
// =============================================================================

/**
 * SQLite-specific DDL for model table creation.
 */
export class DdlCreateModelSqlite extends DdlCreateModelBase {
    readonly name = 'DdlCreateModelSqlite';
    readonly dialect = 'sqlite' as const;

    /**
     * Build SQLite CREATE TABLE statement.
     *
     * WHY TEXT for timestamps: SQLite has no native datetime type.
     * ISO 8601 strings sort correctly and are human-readable.
     *
     * WHY randomblob: SQLite doesn't have gen_random_uuid().
     * 16 random bytes = 128-bit UUID equivalent.
     */
    protected buildCreateTable(tableName: string): string {
        return `
            CREATE TABLE IF NOT EXISTS ${tableName} (
                id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now')),
                trashed_at  TEXT,
                expired_at  TEXT
            )
        `;
    }
}

export default DdlCreateModelSqlite;
