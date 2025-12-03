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
 * import { createDatabase, DatabaseConnection } from '@src/model/connection.js';
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
 * Path to the schema.sql file.
 *
 * WHY: Using import.meta.url ensures the path is relative to this module,
 * regardless of the current working directory.
 */
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url).pathname;

/**
 * Cached schema SQL content.
 *
 * WHY: Avoid re-reading the schema file for every database creation.
 * Schema is loaded once on first use.
 *
 * INVARIANT: Once set, never changes (schema is static).
 */
let cachedSchema: string | null = null;

// =============================================================================
// SCHEMA LOADING
// =============================================================================

/**
 * Load the schema SQL content via HAL FileDevice.
 *
 * ALGORITHM:
 * 1. Check if schema is cached
 * 2. If not, read schema.sql via HAL FileDevice
 * 3. Cache and return content
 *
 * WHY FileDevice parameter: Maintains HAL boundary - no direct Bun.file()
 * access outside HAL. The FileDevice is provided by the kernel.
 *
 * @param fileDevice - HAL FileDevice for reading schema file
 * @returns Promise resolving to schema SQL content
 * @throws Error if schema.sql cannot be read
 */
async function loadSchemaAsync(fileDevice: FileDevice): Promise<string> {
    if (cachedSchema === null) {
        cachedSchema = await fileDevice.readText(SCHEMA_PATH);
    }
    return cachedSchema;
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

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a database connection from a HAL channel.
     *
     * WHY private: Use factory functions (createDatabase, etc.) instead.
     * This ensures proper initialization with schema.
     *
     * @param channel - HAL SQLite channel
     * @param path - Database path (for debugging)
     */
    constructor(channel: Channel, path: string) {
        this.channel = channel;
        this.path = path;
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
            if (response.op === 'item') {
                rows.push(response.data as T);
            } else if (response.op === 'done') {
                break;
            } else if (response.op === 'error') {
                const err = response.data as { code: string; message: string };
                throw new Error(`Query failed: ${err.message}`);
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
            if (response.op === 'ok') {
                const data = response.data as { affectedRows: number };
                return data.affectedRows;
            } else if (response.op === 'error') {
                const err = response.data as { code: string; message: string };
                throw new Error(`Execute failed: ${err.message}`);
            }
        }

        throw new Error('Execute returned no response');
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
            if (response.op === 'ok') {
                return;
            } else if (response.op === 'error') {
                const err = response.data as { code: string; message: string };
                throw new Error(`Exec failed: ${err.message}`);
            }
        }

        throw new Error('Exec returned no response');
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
 * WHY separate from createDatabase: Allows creating connection without
 * schema for cases like connecting to existing databases.
 *
 * @param channelDevice - HAL channel device for opening SQLite channel
 * @param path - SQLite database path, or ':memory:' for in-memory
 * @returns Promise resolving to DatabaseConnection
 */
export async function createDatabaseConnection(
    channelDevice: ChannelDevice,
    path: string = DEFAULT_PATH
): Promise<DatabaseConnection> {
    const channel = await channelDevice.open('sqlite', path);
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
    path: string = DEFAULT_PATH
): Promise<DatabaseConnection> {
    const conn = await createDatabaseConnection(channelDevice, path);

    // Load and execute schema via HAL
    const schema = await loadSchemaAsync(fileDevice);
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
    schema: string
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
 * @returns Promise resolving to schema SQL content
 */
export async function getSchema(fileDevice: FileDevice): Promise<string> {
    return loadSchemaAsync(fileDevice);
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
    cachedSchema = null;
}
