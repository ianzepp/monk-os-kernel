/**
 * Database Connection - HAL-based SQLite/PostgreSQL database management
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides database connection management using HAL's channel
 * abstraction to access SQLite or PostgreSQL. This enforces the architectural
 * boundary: Bun is the hardware, HAL is the abstraction layer.
 *
 * The module provides:
 * - DatabaseConnection: A wrapper around HAL's database channel with convenient methods
 * - Factory functions: Create database connections
 *
 * DATABASE OPERATIONS
 * ===================
 * All database operations flow through HAL's channel interface:
 * ```
 * Higher Layers (EMS, VFS, etc.)
 *       |
 *       v
 * DatabaseConnection (this module)
 *       |
 *       v
 * HAL Channel (sqlite/postgres protocol)
 *       |
 *       v
 * bun:sqlite / Bun.SQL (hardware)
 * ```
 *
 * USAGE
 * =====
 * ```typescript
 * import { createDatabaseConnection, DatabaseConnection } from '@src/hal/connection.js';
 * import { BunChannelDevice } from '@src/hal/channel.js';
 *
 * const channelDevice = new BunChannelDevice();
 *
 * // Create database connection
 * const db = await createDatabaseConnection(channelDevice, ':memory:');
 *
 * // Query
 * const rows = await db.query('SELECT * FROM users');
 *
 * // Execute
 * const result = await db.execute('INSERT INTO users (name) VALUES (?)', ['test']);
 *
 * // Close
 * await db.close();
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: All database operations go through HAL channel (no direct bun:sqlite)
 * INV-2: DatabaseConnection owns the channel and must close it
 * INV-3: Query results are fully materialized (not streaming)
 *
 * CONCURRENCY MODEL
 * =================
 * SQLite with WAL mode allows:
 * - Multiple concurrent readers
 * - Single writer at a time
 * - Readers do not block writers (and vice versa)
 *
 * PostgreSQL via Bun.SQL:
 * - Connection pooling handled by Bun
 * - Multiple concurrent queries supported
 *
 * @module hal/connection
 */

import type { Channel, ChannelDevice } from './channel.js';
import { EIO } from './errors.js';
import { type DatabaseDialect, getDialect } from './dialect.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default database path for in-memory databases.
 *
 * WHY: In-memory databases are ideal for testing and development.
 * Production deployments should specify a persistent path.
 */
const DEFAULT_PATH = ':memory:';

// =============================================================================
// DATABASE CONNECTION CLASS
// =============================================================================

/**
 * Database connection wrapping a HAL SQLite or PostgreSQL channel.
 *
 * WHY: Provides convenient methods for common database operations while
 * ensuring all operations go through HAL's channel abstraction.
 *
 * DESIGN: Wraps the low-level channel interface (handle() returns
 * AsyncIterable<Response>) with simpler query/execute/exec methods.
 *
 * TESTABILITY: Can be constructed with any Channel implementation,
 * enabling mock channels for unit tests.
 */
export class DatabaseConnection {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Underlying HAL channel.
     *
     * WHY: All database operations go through this channel.
     * INVARIANT: Non-null until close() is called.
     */
    private readonly channel: Channel;

    /**
     * Database path (for debugging).
     *
     * WHY: Useful for error messages and logging.
     */
    readonly path: string;

    /**
     * Database dialect for SQL generation and type conversion.
     *
     * WHY: Provides dialect-specific placeholder syntax (? vs $1),
     * type mapping, and DDL generation. Derived from channel protocol.
     */
    readonly dialect: DatabaseDialect;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a database connection from a HAL channel.
     *
     * @param channel - HAL SQLite or PostgreSQL channel
     * @param path - Database path (for debugging)
     */
    constructor(channel: Channel, path: string) {
        this.channel = channel;
        this.path = path;
        this.dialect = getDialect(channel.proto === 'postgres' ? 'postgres' : 'sqlite');
    }

    // =========================================================================
    // QUERY OPERATIONS
    // =========================================================================

    /**
     * Execute a SELECT query and return all rows.
     *
     * ALGORITHM:
     * 1. Send query message to channel
     * 2. Collect all 'item' responses into array
     * 3. Return rows when 'done' is received
     * 4. Throw on 'error' response
     *
     * @param sql - SQL SELECT statement
     * @param params - Query parameters (positional)
     * @returns Promise resolving to array of rows
     * @throws Error on query failure
     */
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows: T[] = [];

        for await (const response of this.channel.handle({ op: 'query', data: { sql, params } })) {
            switch (response.op) {
                case 'item':
                    rows.push(response.data as T);
                    break;
                case 'done':
                    return rows;
                case 'error': {
                    const err = response.data as { code: string; message: string };

                    throw new EIO(`Query failed [${err.code}]: ${err.message}`);
                }

                default:
                    // SAFETY: Ignore unexpected response types (progress, event, etc.)
                    break;
            }
        }

        return rows;
    }

    /**
     * Execute a SELECT query and return first row or null.
     *
     * WHY: Common pattern for lookups by ID or unique key.
     *
     * @param sql - SQL SELECT statement
     * @param params - Query parameters (positional)
     * @returns Promise resolving to first row or null
     */
    async queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
        const rows = await this.query<T>(sql, params);

        return rows[0] ?? null;
    }

    // =========================================================================
    // EXECUTE OPERATIONS
    // =========================================================================

    /**
     * Execute an INSERT/UPDATE/DELETE statement.
     *
     * ALGORITHM:
     * 1. Send execute message to channel
     * 2. Wait for 'ok' response with affected row count
     * 3. Throw on 'error' response
     *
     * @param sql - SQL INSERT/UPDATE/DELETE statement
     * @param params - Query parameters (positional)
     * @returns Promise resolving to affected row count
     * @throws Error on execution failure
     */
    async execute(sql: string, params?: unknown[]): Promise<number> {
        for await (const response of this.channel.handle({ op: 'execute', data: { sql, params } })) {
            switch (response.op) {
                case 'ok': {
                    const data = response.data as { affectedRows: number };

                    return data.affectedRows;
                }

                case 'error': {
                    const err = response.data as { code: string; message: string };

                    throw new EIO(`Execute failed [${err.code}]: ${err.message}`);
                }

                default:
                    // SAFETY: Ignore unexpected response types
                    break;
            }
        }

        throw new EIO('Execute returned no response');
    }

    /**
     * Execute raw SQL (multiple statements allowed).
     *
     * WHY: Used for schema initialization, migrations, and batch operations.
     * No parameters supported - raw SQL only.
     *
     * ALGORITHM:
     * 1. Send exec message to channel
     * 2. Wait for 'ok' response
     * 3. Throw on 'error' response
     *
     * @param sql - Raw SQL (may contain multiple statements)
     * @throws Error on execution failure
     */
    async exec(sql: string): Promise<void> {
        for await (const response of this.channel.handle({ op: 'exec', data: { sql } })) {
            switch (response.op) {
                case 'ok':
                    return;
                case 'error': {
                    const err = response.data as { code: string; message: string };

                    throw new EIO(`Exec failed [${err.code}]: ${err.message}`);
                }

                default:
                    // SAFETY: Ignore unexpected response types
                    break;
            }
        }

        throw new EIO('Exec returned no response');
    }

    // =========================================================================
    // TRANSACTION OPERATIONS
    // =========================================================================

    /**
     * Execute multiple statements in a single atomic transaction.
     *
     * WHY: Enables atomic multi-statement operations. All statements succeed
     * or all are rolled back. Solves parallel write conflicts by making the
     * entire transaction a single message to the channel.
     *
     * ALGORITHM:
     * 1. Send transaction message to channel with all statements
     * 2. Channel executes within BEGIN/COMMIT (or equivalent)
     * 3. Wait for 'ok' response with per-statement results
     * 4. Throw on 'error' response (transaction already rolled back)
     *
     * CONCURRENCY:
     * Each transaction() call sends a single message. The channel handles
     * atomicity using Bun's sql.begin() (PostgreSQL) or db.transaction()
     * (SQLite). Parallel calls are safe - they serialize at the channel level.
     *
     * @param statements - Array of SQL statements with optional params
     * @returns Promise resolving to array of affected row counts (one per statement)
     * @throws EIO on transaction failure (already rolled back by channel)
     */
    async transaction(
        statements: Array<{ sql: string; params?: unknown[] }>,
    ): Promise<number[]> {
        for await (const response of this.channel.handle({
            op: 'transaction',
            data: { statements },
        })) {
            switch (response.op) {
                case 'ok': {
                    const data = response.data as { results: number[] };

                    return data.results;
                }

                case 'error': {
                    const err = response.data as { code: string; message: string };

                    throw new EIO(`Transaction failed [${err.code}]: ${err.message}`);
                }

                default:
                    // SAFETY: Ignore unexpected response types
                    break;
            }
        }

        throw new EIO('Transaction returned no response');
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Check if connection is closed.
     */
    get closed(): boolean {
        return this.channel.closed;
    }

    /**
     * Close the database connection.
     *
     * WHY: Releases file handle and flushes WAL.
     * INVARIANT: Safe to call multiple times (idempotent).
     */
    async close(): Promise<void> {
        await this.channel.close();
    }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a database connection via HAL channel.
 *
 * ALGORITHM:
 * 1. Open SQLite channel via HAL
 * 2. Wrap in DatabaseConnection
 * 3. Return connection (no schema initialization)
 *
 * @param channelDevice - HAL channel device for opening database channel
 * @param path - Database path, or ':memory:' for in-memory
 * @returns Promise resolving to DatabaseConnection
 */
export async function createDatabaseConnection(
    channelDevice: ChannelDevice,
    path: string = DEFAULT_PATH,
): Promise<DatabaseConnection> {
    const channel = await channelDevice.open('sqlite', path);

    return new DatabaseConnection(channel, path);
}

/**
 * Create a database connection with provided schema (no file read).
 *
 * WHY: For cases where schema is already available (e.g., bundled into
 * the application, or for testing with custom schema).
 *
 * @param channelDevice - HAL channel device for opening database channel
 * @param path - Database path
 * @param schema - Schema SQL to execute
 * @returns Promise resolving to initialized DatabaseConnection
 */
export async function createDatabaseWithSchema(
    channelDevice: ChannelDevice,
    path: string,
    schema: string,
): Promise<DatabaseConnection> {
    const conn = await createDatabaseConnection(channelDevice, path);

    await conn.exec(schema);

    return conn;
}

// =============================================================================
// HELPER TYPES
// =============================================================================

/**
 * Configuration options for database creation.
 *
 * TESTABILITY: Allows tests to override defaults without modifying code.
 */
export interface DatabaseConfig {
    /** Database path (default: ':memory:') */
    path?: string;
}

// =============================================================================
// PUBLIC ACCESSORS (for testing)
// =============================================================================

/**
 * Get the default database path.
 *
 * TESTABILITY: Allows tests to verify default path behavior.
 *
 * @returns Default database path (':memory:')
 */
export function getDefaultPath(): string {
    return DEFAULT_PATH;
}
