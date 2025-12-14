/**
 * EMS Database - Entity Management System database initialization
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides EMS-specific database creation with schema initialization.
 * It builds on HAL's generic DatabaseConnection and adds EMS schema loading.
 *
 * The generic database primitives (DatabaseConnection, createDatabaseConnection)
 * live in HAL. This module adds the EMS-specific schema loading on top.
 *
 * USAGE
 * =====
 * ```typescript
 * import { createDatabase } from '@src/ems/database.js';
 * import { BunChannelDevice, BunFileDevice } from '@src/hal/index.js';
 *
 * const channelDevice = new BunChannelDevice();
 * const fileDevice = new BunFileDevice();
 * const db = await createDatabase(channelDevice, fileDevice);
 *
 * // Database is now initialized with EMS schema (models, fields, entities tables)
 * const models = await db.query("SELECT model_name FROM models WHERE status = 'system'");
 * ```
 *
 * @module ems/database
 */

import type { ChannelDevice } from '@src/hal/channel.js';
import type { FileDevice } from '@src/hal/file.js';
import type { DatabaseDialect } from '@src/hal/dialect.js';
import type {
    DatabaseConnection } from '@src/hal/connection.js';
import {
    createDatabaseConnection,
    getDefaultPath,
} from '@src/hal/connection.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Paths to the EMS schema files (dialect-specific).
 *
 * WHY: Using import.meta.url ensures the paths are relative to this module,
 * regardless of the current working directory.
 */
const SCHEMA_PATHS = {
    sqlite: new URL('./schema.sqlite.sql', import.meta.url).pathname,
    postgres: new URL('./schema.pg.sql', import.meta.url).pathname,
} as const;

/**
 * Cached schema SQL content by dialect (Promise-based for race condition safety).
 *
 * WHY Promise: The old pattern `if (cache === null) { cache = await read() }` had
 * a TOCTOU bug where concurrent calls would both read the file before either
 * cached. Using a Promise cache ensures only one read occurs.
 *
 * INVARIANT: Once set, never changes (schema is static per dialect).
 */
const cachedSchemaPromises = {
    sqlite: null as Promise<string> | null,
    postgres: null as Promise<string> | null,
} as const;

// =============================================================================
// SCHEMA LOADING
// =============================================================================

/**
 * Load the EMS schema SQL content via HAL FileDevice.
 *
 * ALGORITHM:
 * 1. Determine dialect from connection
 * 2. Check if Promise is cached for that dialect
 * 3. If not, start read and cache the Promise immediately
 * 4. Return cached Promise (all callers share same read)
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
 * @param dialect - Database dialect ('sqlite' or 'postgres')
 * @returns Promise resolving to schema SQL content
 * @throws Error if schema file cannot be read
 */
async function loadSchemaAsync(fileDevice: FileDevice, dialect: DatabaseDialect): Promise<string> {
    const dialectName = dialect.name as 'sqlite' | 'postgres';
    const cacheKey = dialectName as keyof typeof cachedSchemaPromises;

    if (cachedSchemaPromises[cacheKey] === null) {
        const schemaPath = SCHEMA_PATHS[cacheKey];

        // Cache the Promise immediately - all concurrent callers share this read
        (cachedSchemaPromises as Record<string, Promise<string> | null>)[cacheKey] = fileDevice.readText(schemaPath);
    }

    const promise = cachedSchemaPromises[cacheKey];

    return promise!;
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a database with the EMS schema initialized.
 *
 * ALGORITHM:
 * 1. Open database channel via HAL
 * 2. Determine dialect from connection
 * 3. Load dialect-specific schema.sql content via HAL FileDevice
 * 4. Execute schema via channel's exec operation
 * 5. Return ready-to-use DatabaseConnection
 *
 * @param channelDevice - HAL channel device for opening database channel
 * @param fileDevice - HAL file device for reading schema files
 * @param path - Database path, or ':memory:' for in-memory (default)
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
    path: string = getDefaultPath(),
): Promise<DatabaseConnection> {
    const conn = await createDatabaseConnection(channelDevice, path);

    // Load and execute dialect-specific EMS schema via HAL
    const schema = await loadSchemaAsync(fileDevice, conn.dialect);

    await conn.exec(schema);

    return conn;
}

// =============================================================================
// PUBLIC ACCESSORS (for testing)
// =============================================================================

/**
 * Get the EMS schema SQL content for a specific dialect.
 *
 * TESTABILITY: Allows tests to verify schema content or use it directly.
 *
 * @param fileDevice - HAL file device for reading schema files
 * @param dialect - Database dialect ('sqlite' or 'postgres')
 * @returns Promise resolving to schema SQL content
 */
export async function getSchema(fileDevice: FileDevice, dialect: DatabaseDialect): Promise<string> {
    return loadSchemaAsync(fileDevice, dialect);
}

/**
 * Clear the cached schemas (for testing).
 *
 * TESTABILITY: Allows tests to force schema reload.
 *
 * WHY: Tests may modify schema files and need to reload them.
 */
export function clearSchemaCache(): void {
    (cachedSchemaPromises as Record<string, Promise<string> | null>).sqlite = null;
    (cachedSchemaPromises as Record<string, Promise<string> | null>).postgres = null;
}

// =============================================================================
// RE-EXPORTS FROM HAL
// =============================================================================

// Re-export the generic connection types/functions for convenience
export {
    DatabaseConnection,
    createDatabaseConnection,
    createDatabaseWithSchema,
    getDefaultPath,
    type DatabaseConfig,
} from '@src/hal/connection.js';
