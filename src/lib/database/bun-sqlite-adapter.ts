/**
 * Bun SQLite Database Adapter
 *
 * Uses Bun's native bun:sqlite for high-performance SQLite access.
 * This adapter is used when running under Bun runtime for smaller
 * distribution size (no native dependencies).
 *
 * Path convention: {SQLITE_DATA_DIR}/{db}/{ns}.db
 */

import { join } from 'path';
import { Database } from 'bun:sqlite';
import type { DatabaseAdapter, QueryResult, DatabaseType } from './adapter.js';

/**
 * Get SQLite data directory from environment
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
 * Bun SQLite implementation of DatabaseAdapter
 *
 * Note: bun:sqlite is synchronous, but we use async interface
 * for consistency with PostgreSQL adapter.
 *
 * Limitations:
 * - No custom regexp function (Bun doesn't support db.function())
 */
export class BunSqliteAdapter implements DatabaseAdapter {
    private readonly dbPath: string;
    private db: Database | null = null;
    private inTransaction: boolean = false;

    constructor(db: string, ns: string) {
        this.dbPath = join(getSqliteDataDir(), db, `${ns}.db`);
    }

    async connect(): Promise<void> {
        if (this.db) {
            return;
        }

        // Open database file (creates if doesn't exist)
        this.db = new Database(this.dbPath, { create: true });

        // Enable WAL mode for better concurrent read performance
        this.db.exec('PRAGMA journal_mode = WAL');

        // Enable foreign keys
        this.db.exec('PRAGMA foreign_keys = ON');
    }

    async disconnect(): Promise<void> {
        if (!this.db) {
            return;
        }

        if (this.inTransaction) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                // Ignore rollback errors during disconnect
            }
            this.inTransaction = false;
        }

        this.db.close();
        this.db = null;
    }

    isConnected(): boolean {
        return this.db !== null;
    }

    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
        if (!this.db) {
            throw new Error('BunSqliteAdapter: Not connected. Call connect() first.');
        }

        // Convert PostgreSQL $1, $2 placeholders to SQLite ? placeholders
        const convertedSql = this.convertPlaceholders(sql);

        // Determine if this is a SELECT or data modification query
        const isSelect = /^\s*SELECT/i.test(convertedSql);

        if (isSelect) {
            const stmt = this.db.query(convertedSql);
            const rows = params && params.length > 0
                ? stmt.all(...(params as (string | number | boolean | null | Uint8Array)[]))
                : stmt.all();

            return {
                rows: rows as T[],
                rowCount: rows.length,
            };
        } else {
            // INSERT/UPDATE/DELETE
            const stmt = this.db.query(convertedSql);
            const result = params && params.length > 0
                ? stmt.run(...(params as (string | number | boolean | null | Uint8Array)[]))
                : stmt.run();

            return {
                rows: [] as T[],
                rowCount: result.changes,
            };
        }
    }

    async beginTransaction(): Promise<void> {
        if (!this.db) {
            throw new Error('BunSqliteAdapter: Not connected. Call connect() first.');
        }

        if (this.inTransaction) {
            throw new Error('BunSqliteAdapter: Transaction already in progress');
        }

        this.db.exec('BEGIN');
        this.inTransaction = true;
    }

    async commit(): Promise<void> {
        if (!this.db) {
            throw new Error('BunSqliteAdapter: Not connected. Call connect() first.');
        }

        if (!this.inTransaction) {
            throw new Error('BunSqliteAdapter: No transaction in progress');
        }

        this.db.exec('COMMIT');
        this.inTransaction = false;
    }

    async rollback(): Promise<void> {
        if (!this.db) {
            throw new Error('BunSqliteAdapter: Not connected. Call connect() first.');
        }

        if (!this.inTransaction) {
            return;
        }

        this.db.exec('ROLLBACK');
        this.inTransaction = false;
    }

    getType(): DatabaseType {
        return 'sqlite';
    }

    getRawConnection(): Database | null {
        return this.db;
    }

    isInTransaction(): boolean {
        return this.inTransaction;
    }

    getPath(): string {
        return this.dbPath;
    }

    private convertPlaceholders(sql: string): string {
        const placeholders = sql.match(/\$\d+/g);
        if (!placeholders) {
            return sql;
        }

        // Sort by number descending to replace $10 before $1
        const sortedPlaceholders = [...new Set(placeholders)]
            .sort((a, b) => parseInt(b.slice(1)) - parseInt(a.slice(1)));

        let result = sql;
        for (const placeholder of sortedPlaceholders) {
            result = result.split(placeholder).join('?');
        }

        return result;
    }
}
