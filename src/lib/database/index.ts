/**
 * Database Module
 *
 * Exports:
 * - Database service class for high-level operations
 * - Database adapter factory for low-level connections
 * - Types for both service and adapters
 *
 * Uses bun:sqlite for SQLite (no native dependencies).
 */

// Database Service (high-level operations)
export { Database } from './service.js';
export type { CachedRelationship, SelectOptions } from './types.js';
export type { ExportOptions, ExportResult } from './export.js';
export type { ImportOptions, ImportResult, ImportStrategy } from './import.js';

// Database Adapters (low-level connections)
export type { DatabaseAdapter, QueryResult, DatabaseType, AdapterConfig } from './adapter.js';
export { PostgresAdapter } from './postgres-adapter.js';
export { BunSqliteAdapter } from './bun-sqlite-adapter.js';

import type { DatabaseAdapter, AdapterConfig, DatabaseType } from './adapter.js';
import { PostgresAdapter } from './postgres-adapter.js';
import { BunSqliteAdapter } from './bun-sqlite-adapter.js';

/**
 * Create a database adapter based on configuration
 *
 * Factory function that selects the appropriate adapter implementation
 * based on the db_type field from tenant configuration (JWT).
 *
 * @param config - Adapter configuration (dbType, db, ns)
 * @returns Database adapter instance (not yet connected)
 *
 * @example
 * // From JWT claims:
 * const adapter = createAdapter({
 *   dbType: jwt.db_type,  // 'postgresql' or 'sqlite'
 *   db: jwt.db,           // Database name or directory
 *   ns: jwt.ns            // Schema name or filename
 * });
 * await adapter.connect();
 */
export function createAdapter(config: AdapterConfig): DatabaseAdapter {
    const { dbType, db, ns } = config;

    switch (dbType) {
        case 'sqlite':
            return new BunSqliteAdapter(db, ns);

        case 'postgresql':
        default:
            return new PostgresAdapter(db, ns);
    }
}

/**
 * Create adapter from individual parameters (convenience function)
 *
 * @param dbType - Database type ('postgresql' or 'sqlite')
 * @param db - Database name (PostgreSQL) or directory (SQLite)
 * @param ns - Schema name (PostgreSQL) or filename (SQLite)
 * @returns Database adapter instance (not yet connected)
 */
export function createAdapterFrom(
    dbType: DatabaseType,
    db: string,
    ns: string
): DatabaseAdapter {
    return createAdapter({ dbType, db, ns });
}

/**
 * Check if a database type is supported
 *
 * @param dbType - Database type to check
 * @returns true if supported
 */
export function isSupportedDatabaseType(dbType: string): dbType is DatabaseType {
    return dbType === 'postgresql' || dbType === 'sqlite';
}

/**
 * Get the default database type
 *
 * Used when db_type is not specified during tenant registration.
 */
export function getDefaultDatabaseType(): DatabaseType {
    return 'postgresql';
}
