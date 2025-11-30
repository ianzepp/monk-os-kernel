/**
 * Database Adapter Interface
 *
 * Abstraction layer for database backends (PostgreSQL, SQLite).
 * Each tenant specifies a db_type that determines which adapter is used.
 *
 * Design:
 * - Adapters are per-request instances (like transaction contexts)
 * - Connection lifecycle managed by adapter
 * - Query interface matches pg.PoolClient for easy migration
 */

/**
 * Supported database backend types
 */
export type DatabaseType = 'postgresql' | 'sqlite';

/**
 * Query result matching pg.QueryResult structure
 */
export interface QueryResult<T = Record<string, unknown>> {
    /** Array of result rows */
    rows: T[];
    /** Number of rows affected (for INSERT/UPDATE/DELETE) */
    rowCount: number;
    /** Field metadata (optional, PostgreSQL-specific) */
    fields?: Array<{
        name: string;
        dataTypeID?: number;
    }>;
}

/**
 * Database Adapter Interface
 *
 * All database operations flow through this interface.
 * Implementations handle dialect-specific SQL generation and connection management.
 */
export interface DatabaseAdapter {
    /**
     * Establish connection to the database
     *
     * For PostgreSQL: Acquires client from pool and sets search_path
     * For SQLite: Opens file handle
     */
    connect(): Promise<void>;

    /**
     * Release connection resources
     *
     * For PostgreSQL: Releases client back to pool
     * For SQLite: Closes file handle
     */
    disconnect(): Promise<void>;

    /**
     * Check if adapter has an active connection
     */
    isConnected(): boolean;

    /**
     * Execute SQL query with optional parameters
     *
     * Uses parameterized queries for security.
     * Parameter placeholder format:
     * - PostgreSQL: $1, $2, $3...
     * - SQLite: ?, ?, ?... (adapter handles conversion)
     *
     * @param sql - SQL query string
     * @param params - Optional parameter values
     * @returns Query result with rows and metadata
     */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

    /**
     * Begin a database transaction
     *
     * Must call commit() or rollback() to complete.
     */
    beginTransaction(): Promise<void>;

    /**
     * Commit the current transaction
     */
    commit(): Promise<void>;

    /**
     * Rollback the current transaction
     */
    rollback(): Promise<void>;

    /**
     * Get the database backend type
     *
     * Used by observer filtering to run dialect-specific observers.
     */
    getType(): DatabaseType;

    /**
     * Get the underlying connection for advanced operations
     *
     * Returns the raw connection object (pg.PoolClient or bun:sqlite Database).
     * Use sparingly - prefer query() for normal operations.
     */
    getRawConnection(): unknown;
}

/**
 * Configuration for creating a database adapter
 */
export interface AdapterConfig {
    /** Database type ('postgresql' or 'sqlite') */
    dbType: DatabaseType;

    /**
     * Database identifier
     * - PostgreSQL: Database name
     * - SQLite: Directory path
     */
    db: string;

    /**
     * Namespace identifier
     * - PostgreSQL: Schema name
     * - SQLite: Filename (without .db extension)
     */
    ns: string;
}
