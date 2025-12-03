/**
 * Model Layer - Public Exports
 *
 * This module re-exports the public API for the model layer, which provides:
 * - Database schema and connection management
 * - Model and field metadata classes
 * - Change tracking for entity mutations
 * - Model caching with async HAL-based access
 * - DatabaseService for high-level CRUD operations
 * - Observer pipeline for entity mutations
 *
 * USAGE
 * =====
 * ```typescript
 * import {
 *     createDatabase,
 *     createDatabaseConnection,
 *     Model,
 *     ModelRecord,
 *     ModelCache,
 *     DatabaseService,
 *     ObserverRunner,
 *     ObserverRing,
 * } from '@src/model/index.js';
 *
 * // Create database with schema
 * const db = await createDatabase(channelDevice, fileDevice);
 *
 * // Create cache and service
 * const cache = new ModelCache(db);
 * const runner = new ObserverRunner();
 * const service = new DatabaseService(db, cache, runner);
 *
 * // Use the service
 * const file = await service.createOne('file', { name: 'test.txt', owner: 'user-123' });
 * ```
 *
 * @module model
 */

// =============================================================================
// CONNECTION / SCHEMA
// =============================================================================

export {
    DatabaseConnection,
    createDatabase,
    createDatabaseConnection,
    createDatabaseWithSchema,
    getSchema,
    getDefaultPath,
    clearSchemaCache,
    type DatabaseConfig,
} from './connection.js';

// =============================================================================
// MODEL METADATA
// =============================================================================

export { Model, type ModelRow, type FieldRow as ModelFieldRow } from './model.js';

// =============================================================================
// CHANGE TRACKING
// =============================================================================

export { ModelRecord, type RecordData, type FieldDiff, type RecordDiff } from './model-record.js';

// =============================================================================
// MODEL CACHE
// =============================================================================

export { ModelCache } from './model-cache.js';

// =============================================================================
// DATABASE SERVICE
// =============================================================================

export {
    DatabaseService,
    type DbRecord,
    type SelectOptions,
    type ModelSystemContext,
} from './database.js';

// =============================================================================
// OBSERVER PIPELINE
// =============================================================================

export {
    // Types
    ObserverRing,
    type OperationType,
    type ObserverResult,
    // Interfaces (Model, ModelRecord, FieldRow exported above from concrete implementations)
    type Observer,
    type ObserverContext,
    type SystemContext,
    // Errors
    ObserverError,
    EOBSINVALID,
    EOBSFROZEN,
    EOBSIMMUT,
    EOBSSEC,
    EOBSBUS,
    EOBSSYS,
    EOBSTIMEOUT,
    EOBSERVER,
    isObserverError,
    isValidationError,
    hasErrorCode,
    // Base class
    BaseObserver,
    // Runner
    ObserverRunner,
    // Registry
    createObserverRunner,
} from './observers/index.js';
