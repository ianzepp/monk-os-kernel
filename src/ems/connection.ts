/**
 * Model Database Connection - HAL-based SQLite database management
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides database connection management for the model layer,
 * using HAL's channel abstraction to access SQLite. This enforces the
 * architectural boundary: Bun is the hardware, HAL is the abstraction layer,
 * and the model layer goes through HAL to access databases.
 *
 * The module provides:
 * - DatabaseConnection: A wrapper around HAL's SQLite channel with convenient methods
 * - Factory functions: Create initialized database connections with schema
 *
 * DATABASE OPERATIONS
 * ===================
 * All database operations flow through HAL's channel interface:
 * ```
 * Model Layer (this module)
 *       │
 *       ▼
 * HAL Channel (sqlite protocol)
 *       │
 *       ▼
 * bun:sqlite (hardware)
 * ```
 *
 * USAGE
 * =====
 * ```typescript
 * import { createDatabase, DatabaseConnection } from '@src/ems/connection.js';
 * import { BunChannelDevice } from '@src/hal/channel.js';
 *
 * const channelDevice = new BunChannelDevice();
 *
 * // Create database with schema
 * const db = await createDatabase(channelDevice, ':memory:');
 *
 * // Query
 * const rows = await db.query('SELECT * FROM models');
 *
 * // Execute
 * const result = await db.execute('INSERT INTO models (model_name) VALUES (?)', ['test']);
 *
 * // Close
 * await db.close();
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: All database operations go through HAL channel (no direct bun:sqlite)
 * INV-2: Schema is idempotent - safe to run multiple times
 * INV-3: DatabaseConnection owns the channel and must close it
 * INV-4: Query results are fully materialized (not streaming)
 *
 * CONCURRENCY MODEL
 * =================
 * SQLite with WAL mode allows:
 * - Multiple concurrent readers
 * - Single writer at a time
 * - Readers do not block writers (and vice versa)
 *
 * The channel interface is async but SQLite operations are synchronous
 * internally (bun:sqlite is sync). No async interleaving within a query.
 *
 * @module model/connection
 */

import type { Channel, ChannelDevice } from '@src/hal/channel.js';
import type { FileDevice } from '@src/hal/file.js';
import { EIO } from '@src/hal/errors.js';
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

/**
 * Paths to schema SQL files.
 *
 * WHY: Using import.meta.url ensures the path is relative to this module,
 * regardless of the current working directory.
 */
const SCHEMA_SQLITE_PATH = new URL('./schema.sqlite.sql', import.meta.url).pathname;
const SCHEMA_POSTGRES_PATH = new URL('./schema.postgres.sql', import.meta.url).pathname;

/**
 * Cached schema SQL content (Promise-based for race condition safety).
 *
 * WHY Promise: The old pattern `if (cache === null) { cache = await read() }` had
 * a TOCTOU bug where concurrent calls would both read the file before either
 * cached. Using a Promise cache ensures only one read occurs.
 *
 * INVARIANT: Once set, never changes (schema is static).
 */
let cachedSqliteSchemaPromise: Promise<string> | null = null;
let cachedPostgresSchemaPromise: Promise<string> | null = null;

// =============================================================================
// SCHEMA LOADING
// =============================================================================

/**
 * Load the schema SQL content via HAL FileDevice.
 *
 * ALGORITHM:
 * 1. Check if Promise is cached for this dialect
 * 2. If not, start read and cache the Promise immediately
 * 3. Return cached Promise (all callers share same read)
 *
 * RACE CONDITION FIX: By caching the Promise (not the result), concurrent
 * calls share the same in-flight read. The old check-then-read pattern:
 *   if (cache === null) { cache = await read() }
 * allowed two concurrent calls to both start reads before either completed.
 *
 * WHY FileDevice parameter: Maintains HAL boundary - no direct Bun.file()
 * access outside HAL. The FileDevice is provided by the kernel.
 *
 * @param fileDevice - HAL FileDevice for reading schema file
 * @param dialect - Database dialect (sqlite or postgres)
 * @returns Promise resolving to schema SQL content
 * @throws Error if schema.sql cannot be read
 */
async function loadSchemaAsync(
    fileDevice: FileDevice,
    dialect: 'sqlite' | 'postgres' = 'sqlite',
): Promise<string> {
    if (dialect === 'postgres') {
        if (cachedPostgresSchemaPromise === null) {
            cachedPostgresSchemaPromise = fileDevice.readText(SCHEMA_POSTGRES_PATH);
        }

        return cachedPostgresSchemaPromise;
    }

    if (cachedSqliteSchemaPromise === null) {
        cachedSqliteSchemaPromise = fileDevice.readText(SCHEMA_SQLITE_PATH);
    }

    return cachedSqliteSchemaPromise;
}

// =============================================================================
// DATABASE CONNECTION CLASS
// =============================================================================

/**
 * Database connection wrapping a HAL SQLite channel.
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
     * Database dialect instance for SQL generation.
     *
     * WHY: Provides dialect-specific placeholder syntax, type mapping,
     * and DDL generation. Derived from the channel's protocol type.
     */
    readonly dialect: DatabaseDialect;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a database connection from a HAL channel.
     *
     * WHY private: Use factory functions (createDatabase, etc.) instead.
     * This ensures proper initialization with schema.
     *
     * @param channel - HAL SQLite/PostgreSQL channel
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
                    // These should not occur in SQLite channel but don't break if they do.
                    // Log for debugging if needed: console.warn(`Unexpected response.op: ${response.op}`);
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
                    // SAFETY: Ignore unexpected response types (progress, event, etc.)
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
                    // SAFETY: Ignore unexpected response types (progress, event, etc.)
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
 * 1. Detect protocol from path (postgres:// or sqlite file)
 * 2. Open appropriate channel via HAL
 * 3. Wrap in DatabaseConnection
 * 4. Return connection (no schema initialization)
 *
 * WHY separate from createDatabase: Allows creating connection without
 * schema for cases like connecting to existing databases.
 *
 * @param channelDevice - HAL channel device for opening database channel
 * @param path - Database path: SQLite file, ':memory:', or postgres:// URL
 * @returns Promise resolving to DatabaseConnection
 */
export async function createDatabaseConnection(
    channelDevice: ChannelDevice,
    path: string = DEFAULT_PATH,
): Promise<DatabaseConnection> {
    // Detect protocol from path
    const proto = path.startsWith('postgres://') || path.startsWith('postgresql://')
        ? 'postgres'
        : 'sqlite';

    const channel = await channelDevice.open(proto, path);

    return new DatabaseConnection(channel, path);
}

/**
 * Create a database with the model schema initialized.
 *
 * ALGORITHM:
 * 1. Open SQLite channel via HAL
 * 2. Load schema.sql content via HAL FileDevice
 * 3. Execute schema via channel's exec operation
 * 4. Return ready-to-use DatabaseConnection
 *
 * @param channelDevice - HAL channel device for opening SQLite channel
 * @param fileDevice - HAL file device for reading schema.sql
 * @param path - SQLite database path, or ':memory:' for in-memory (default)
 * @returns Promise resolving to initialized DatabaseConnection
 *
 * @example
 * ```typescript
 * import { BunChannelDevice, BunFileDevice } from '@src/hal/index.js';
 *
 * const channelDevice = new BunChannelDevice();
 * const fileDevice = new BunFileDevice();
 * const db = await createDatabase(channelDevice, fileDevice);
 *
 * const models = await db.query("SELECT model_name FROM models WHERE status = 'system'");
 * ```
 */
export async function createDatabase(
    channelDevice: ChannelDevice,
    fileDevice: FileDevice,
    path: string = DEFAULT_PATH,
): Promise<DatabaseConnection> {
    const conn = await createDatabaseConnection(channelDevice, path);

    // Load and execute schema via HAL (dialect-specific)
    const schema = await loadSchemaAsync(fileDevice, conn.dialect.name);

    await conn.exec(schema);

    return conn;
}

/**
 * Create a database with provided schema (no file read).
 *
 * WHY: For cases where schema is already available (e.g., bundled into
 * the application, or for testing with custom schema).
 *
 * @param channelDevice - HAL channel device for opening SQLite channel
 * @param path - SQLite database path
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
    /** SQLite database path (default: ':memory:') */
    path?: string;
}

// =============================================================================
// PUBLIC ACCESSORS (for testing)
// =============================================================================

/**
 * Get the schema SQL content.
 *
 * TESTABILITY: Allows tests to verify schema content or use it directly.
 *
 * @param fileDevice - HAL file device for reading schema.sql
 * @param dialect - Database dialect (sqlite or postgres)
 * @returns Promise resolving to schema SQL content
 */
export async function getSchema(
    fileDevice: FileDevice,
    dialect: 'sqlite' | 'postgres' = 'sqlite',
): Promise<string> {
    return loadSchemaAsync(fileDevice, dialect);
}

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

/**
 * Clear the cached schema (for testing).
 *
 * TESTABILITY: Allows tests to force schema reload.
 *
 * WHY: Tests may modify schema.sql and need to reload it.
 */
export function clearSchemaCache(): void {
    cachedSqliteSchemaPromise = null;
    cachedPostgresSchemaPromise = null;
}
