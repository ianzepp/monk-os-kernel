/**
 * PostgreSQL Database Adapter
 *
 * Wraps existing pg.Pool/pg.PoolClient functionality with the DatabaseAdapter interface.
 * No behavior changes from existing code - just encapsulation.
 */

import pg from 'pg';
import type { DatabaseAdapter, QueryResult, DatabaseType } from './adapter.js';
import { DatabaseConnection } from '@src/lib/database-connection.js';

/**
 * PostgreSQL implementation of DatabaseAdapter
 *
 * Lifecycle:
 * 1. connect() - Acquires client from pool, sets search_path
 * 2. query() - Executes queries through client
 * 3. beginTransaction/commit/rollback - Transaction control
 * 4. disconnect() - Releases client back to pool
 */
export class PostgresAdapter implements DatabaseAdapter {
    private readonly dbName: string;
    private readonly nsName: string;
    private pool: pg.Pool | null = null;
    private client: pg.PoolClient | null = null;
    private inTransaction: boolean = false;

    /**
     * Create a PostgreSQL adapter
     *
     * @param db - Database name
     * @param ns - Schema name (namespace)
     */
    constructor(db: string, ns: string) {
        this.dbName = db;
        this.nsName = ns;
    }

    /**
     * Acquire client from pool and configure search_path
     */
    async connect(): Promise<void> {
        if (this.client) {
            return; // Already connected
        }

        // Get or create pool for this database
        this.pool = DatabaseConnection.getPool(this.dbName);

        // Acquire client from pool
        this.client = await this.pool.connect();

        // Set search_path to namespace
        // Uses identifier quoting for safety
        await this.client.query(`SET search_path TO "${this.nsName}", public`);
    }

    /**
     * Release client back to pool
     */
    async disconnect(): Promise<void> {
        if (!this.client) {
            return; // Not connected
        }

        // Rollback any uncommitted transaction
        if (this.inTransaction) {
            try {
                await this.client.query('ROLLBACK');
            } catch {
                // Ignore rollback errors during disconnect
            }
            this.inTransaction = false;
        }

        // Release client back to pool
        this.client.release();
        this.client = null;
    }

    /**
     * Check if adapter has an active client
     */
    isConnected(): boolean {
        return this.client !== null;
    }

    /**
     * Execute SQL query
     *
     * PostgreSQL uses $1, $2, $3... for parameter placeholders.
     */
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
        if (!this.client) {
            throw new Error('PostgresAdapter: Not connected. Call connect() first.');
        }

        const result = params && params.length > 0
            ? await this.client.query(sql, params)
            : await this.client.query(sql);

        return {
            rows: result.rows as T[],
            rowCount: result.rowCount ?? 0,
            fields: result.fields?.map(f => ({
                name: f.name,
                dataTypeID: f.dataTypeID,
            })),
        };
    }

    /**
     * Begin a database transaction
     */
    async beginTransaction(): Promise<void> {
        if (!this.client) {
            throw new Error('PostgresAdapter: Not connected. Call connect() first.');
        }

        if (this.inTransaction) {
            throw new Error('PostgresAdapter: Transaction already in progress');
        }

        await this.client.query('BEGIN');
        this.inTransaction = true;
    }

    /**
     * Commit the current transaction
     */
    async commit(): Promise<void> {
        if (!this.client) {
            throw new Error('PostgresAdapter: Not connected. Call connect() first.');
        }

        if (!this.inTransaction) {
            throw new Error('PostgresAdapter: No transaction in progress');
        }

        await this.client.query('COMMIT');
        this.inTransaction = false;
    }

    /**
     * Rollback the current transaction
     */
    async rollback(): Promise<void> {
        if (!this.client) {
            throw new Error('PostgresAdapter: Not connected. Call connect() first.');
        }

        if (!this.inTransaction) {
            // Silently ignore rollback when no transaction
            return;
        }

        await this.client.query('ROLLBACK');
        this.inTransaction = false;
    }

    /**
     * Get database type
     */
    getType(): DatabaseType {
        return 'postgresql';
    }

    /**
     * Get underlying pg.PoolClient for advanced operations
     */
    getRawConnection(): pg.PoolClient | null {
        return this.client;
    }

    /**
     * Check if currently in a transaction
     */
    isInTransaction(): boolean {
        return this.inTransaction;
    }
}
