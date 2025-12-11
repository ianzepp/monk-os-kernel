/**
 * Ring 6: Post-Database (DDL)
 *
 * These observers run after Ring 5 (database operations) and handle
 * schema changes like creating tables and adding columns.
 *
 * Observers in this ring are dialect-specific:
 * - DdlCreateModelSqlite / DdlCreateModelPostgres (10): CREATE TABLE
 * - DdlCreateFieldSqlite / DdlCreateFieldPostgres (10): ALTER TABLE ADD COLUMN
 *
 * The observer pipeline filters by dialect, so both SQLite and PostgreSQL
 * observers are registered but only the matching one executes.
 *
 * @module ems/ring/6
 */

// SQLite implementations
export { DdlCreateModelSqlite } from './10-ddl-create-model.sqlite.js';
export { DdlCreateFieldSqlite } from './10-ddl-create-field.sqlite.js';

// PostgreSQL implementations
export { DdlCreateModelPostgres } from './10-ddl-create-model.postgres.js';
export { DdlCreateFieldPostgres } from './10-ddl-create-field.postgres.js';
