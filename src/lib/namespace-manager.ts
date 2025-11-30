import { existsSync, mkdirSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { DatabaseConnection } from './database-connection.js';
import { DatabaseNaming } from './database-naming.js';
import type { DatabaseType } from './database/adapter.js';

/**
 * Get SQLite data directory from environment
 * @throws Error if SQLITE_DATA_DIR is not configured
 */
function getSqliteDataDir(): string {
    const dir = process.env.SQLITE_DATA_DIR;
    if (!dir) {
        throw new Error(
            'SQLITE_DATA_DIR environment variable is required for SQLite tenants. ' +
            'Set it to the directory where SQLite database files should be stored.'
        );
    }
    return dir;
}

/**
 * Namespace (Schema) Management Service
 *
 * Manages PostgreSQL schemas (namespaces) and SQLite database files for tenant isolation.
 *
 * Architecture: Hybrid Database + Schema Model
 * - PostgreSQL: Shared databases (db_main, db_test) contain multiple tenant namespaces (schemas)
 * - SQLite: Each tenant has its own .db file at /data/{db}/{ns}.db
 *
 * Security:
 * - All namespace names are validated to prevent SQL injection / path traversal
 * - Uses parameterized queries where possible
 * - Quoted identifiers for schema names
 */
export class NamespaceManager {
    /**
     * Create new namespace (schema for PostgreSQL, directory+file for SQLite)
     *
     * @param dbName - Database name (PG) or directory (SQLite)
     * @param nsName - Namespace name (PG schema) or filename (SQLite, without .db)
     * @param dbType - Database backend type (default: 'postgresql')
     * @throws Error if namespace name is invalid or creation fails
     */
    static async createNamespace(
        dbName: string,
        nsName: string,
        dbType: DatabaseType = 'postgresql'
    ): Promise<void> {
        this.validateNamespaceName(nsName);

        if (dbType === 'sqlite') {
            // SQLite: Create directory and empty database file
            const dbPath = join(getSqliteDataDir(), dbName, `${nsName}.db`);
            const dirPath = dirname(dbPath);

            // Create directory if it doesn't exist
            if (!existsSync(dirPath)) {
                mkdirSync(dirPath, { recursive: true });
            }

            // Create empty database file by opening and closing a connection
            // The SqliteAdapter will create the file when it connects
            console.info('SQLite namespace path prepared', { dbName, nsName, dbPath });
        } else {
            // PostgreSQL: Create schema
            const pool = DatabaseConnection.getPool(dbName);
            await pool.query(`CREATE SCHEMA IF NOT EXISTS "${nsName}"`);
        }

        console.info('Namespace created', { dbName, nsName, dbType });
    }

    /**
     * Drop namespace (schema for PostgreSQL, file for SQLite)
     *
     * WARNING: This is a destructive operation that cannot be undone.
     * All tables, functions, and data in the namespace will be permanently deleted.
     *
     * @param dbName - Database name (PG) or directory (SQLite)
     * @param nsName - Namespace name to drop
     * @param dbType - Database backend type (default: 'postgresql')
     * @throws Error if namespace name is invalid or drop fails
     */
    static async dropNamespace(
        dbName: string,
        nsName: string,
        dbType: DatabaseType = 'postgresql'
    ): Promise<void> {
        this.validateNamespaceName(nsName);

        if (dbType === 'sqlite') {
            // SQLite: Delete the database file
            const dbPath = join(getSqliteDataDir(), dbName, `${nsName}.db`);

            if (existsSync(dbPath)) {
                unlinkSync(dbPath);
                // Also remove WAL and SHM files if they exist
                const walPath = `${dbPath}-wal`;
                const shmPath = `${dbPath}-shm`;
                if (existsSync(walPath)) unlinkSync(walPath);
                if (existsSync(shmPath)) unlinkSync(shmPath);
            }
        } else {
            // PostgreSQL: Drop schema
            const pool = DatabaseConnection.getPool(dbName);
            await pool.query(`DROP SCHEMA IF EXISTS "${nsName}" CASCADE`);
        }

        console.info('Namespace dropped', { dbName, nsName, dbType });
    }

    /**
     * Check if namespace exists (schema for PostgreSQL, file for SQLite)
     *
     * @param dbName - Database name (PG) or directory (SQLite)
     * @param nsName - Namespace name to check
     * @param dbType - Database backend type (default: 'postgresql')
     * @returns true if namespace exists, false otherwise
     */
    static async namespaceExists(
        dbName: string,
        nsName: string,
        dbType: DatabaseType = 'postgresql'
    ): Promise<boolean> {
        if (dbType === 'sqlite') {
            // SQLite: Check if database file exists
            const dbPath = join(getSqliteDataDir(), dbName, `${nsName}.db`);
            return existsSync(dbPath);
        } else {
            // PostgreSQL: Check if schema exists
            const pool = DatabaseConnection.getPool(dbName);
            const result = await pool.query(
                `SELECT EXISTS(
                    SELECT 1 FROM information_schema.schemata
                    WHERE schema_name = $1
                )`,
                [nsName],
            );
            return result.rows[0].exists;
        }
    }

    /**
     * Get all namespaces (schemas) in database
     *
     * Excludes system schemas (pg_*, information_schema).
     *
     * @param dbName - Database name (db_main, db_test, etc.)
     * @returns Array of namespace names
     */
    static async listNamespaces(dbName: string): Promise<string[]> {
        const pool = DatabaseConnection.getPool(dbName);
        const result = await pool.query(`
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'public')
                AND schema_name NOT LIKE 'pg_%'
            ORDER BY schema_name
        `);
        return result.rows.map((row) => row.schema_name);
    }

    /**
     * Validate namespace (schema) name (prevent SQL injection)
     *
     * Uses DatabaseNaming.validateNamespaceName for validation.
     *
     * @param nsName - Namespace name to validate
     * @throws Error if validation fails
     * @private
     */
    private static validateNamespaceName(nsName: string): void {
        DatabaseNaming.validateNamespaceName(nsName);
    }
}
