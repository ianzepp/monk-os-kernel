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
import {
    DatabaseConnection,
    createDatabaseConnection,
    getDefaultPath,
} from '@src/hal/connection.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Path to the EMS schema.sql file.
 *
 * WHY: Using import.meta.url ensures the path is relative to this module,
 * regardless of the current working directory.
 */
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url).pathname;

/**
 * Cached schema SQL content (Promise-based for race condition safety).
 *
 * WHY Promise: The old pattern `if (cache === null) { cache = await read() }` had
 * a TOCTOU bug where concurrent calls would both read the file before either
 * cached. Using a Promise cache ensures only one read occurs.
 *
 * INVARIANT: Once set, never changes (schema is static).
 */
let cachedSchemaPromise: Promise<string> | null = null;

// =============================================================================
// SCHEMA LOADING
// =============================================================================

/**
 * Load the EMS schema SQL content via HAL FileDevice.
 *
 * ALGORITHM:
 * 1. Check if Promise is cached
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
 * @returns Promise resolving to schema SQL content
 * @throws Error if schema.sql cannot be read
 */
async function loadSchemaAsync(fileDevice: FileDevice): Promise<string> {
    if (cachedSchemaPromise === null) {
        // Cache the Promise immediately - all concurrent callers share this read
        cachedSchemaPromise = fileDevice.readText(SCHEMA_PATH);
    }

    return cachedSchemaPromise;
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a database with the EMS schema initialized.
 *
 * ALGORITHM:
 * 1. Open database channel via HAL
 * 2. Load schema.sql content via HAL FileDevice
 * 3. Execute schema via channel's exec operation
 * 4. Return ready-to-use DatabaseConnection
 *
 * @param channelDevice - HAL channel device for opening database channel
 * @param fileDevice - HAL file device for reading schema.sql
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

    // Load and execute EMS schema via HAL
    const schema = await loadSchemaAsync(fileDevice);

    await conn.exec(schema);

    return conn;
}

// =============================================================================
// PUBLIC ACCESSORS (for testing)
// =============================================================================

/**
 * Get the EMS schema SQL content.
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
 * Clear the cached schema (for testing).
 *
 * TESTABILITY: Allows tests to force schema reload.
 *
 * WHY: Tests may modify schema.sql and need to reload it.
 */
export function clearSchemaCache(): void {
    cachedSchemaPromise = null;
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
