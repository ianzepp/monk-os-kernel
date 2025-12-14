/**
 * Entity Model System (EMS) - Public Exports
 *
 * The main entry point is the EMS class, which encapsulates all components.
 *
 * This module re-exports the public API for the EMS, which provides:
 * - Database schema and connection management
 * - Model and field metadata classes
 * - Change tracking for entity mutations
 * - Model caching with async HAL-based access
 * - DatabaseOps for generic SQL streaming
 * - EntityOps for entity-aware streaming with observer pipeline
 * - Observer pipeline for entity mutations
 *
 * ARCHITECTURE
 * ============
 * ```
 * ┌─────────────────────────────────────┐
 * │  EntityAPI (os.ems)                 │  ← Public: array-based
 * ├─────────────────────────────────────┤
 * │  EntityOps                          │  ← Kernel: streaming + observers
 * ├─────────────────────────────────────┤
 * │  DatabaseOps                        │  ← Kernel: generic SQL streaming
 * ├─────────────────────────────────────┤
 * │  DatabaseConnection                 │  ← HAL: channel wrapper
 * └─────────────────────────────────────┘
 * ```
 *
 * USAGE
 * =====
 * ```typescript
 * import {
 *     createDatabase,
 *     Model,
 *     ModelRecord,
 *     ModelCache,
 *     EntityOps,
 *     DatabaseOps,
 *     ObserverRunner,
 * } from '@src/ems/index.js';
 *
 * // Create database with schema
 * const db = await createDatabase(channelDevice, fileDevice);
 *
 * // For generic SQL streaming (no observers)
 * const dbOps = new DatabaseOps(db);
 * for await (const row of dbOps.query('SELECT * FROM entities')) {
 *     console.log(row);
 * }
 *
 * // For entity operations (with observer pipeline)
 * const cache = new ModelCache(db);
 * const runner = createObserverRunner();
 * const entityOps = new EntityOps(db, cache, runner);
 * for await (const file of entityOps.createAll('file', [{ pathname: 'test.txt' }])) {
 *     console.log(file);
 * }
 * ```
 *
 * @module ems
 */

// =============================================================================
// UNIFIED ENTRY POINT
// =============================================================================

export { EMS, type EMSConfig } from './ems.js';

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
// PATH CACHE (re-export from VFS)
// =============================================================================

export {
    PathCache,
    ROOT_ID,
    type PathEntry,
    type PathEntryInput,
    type PathEntryUpdate,
    type PathCacheStats,
} from '@src/vfs/path-cache.js';

// =============================================================================
// FILTER SYSTEM
// =============================================================================

export {
    FilterOp,
    type FilterData,
    type WhereConditions,
    type WhereValue,
    type OrderSpec,
    type SelectOptions,
    type TrashedOption,
    type CreateInput,
    type UpdateInput,
    type DeleteInput,
    type RevertInput,
    type SqlResult,
    type WhereResult,
} from './filter-types.js';

export { Filter } from './filter.js';

// =============================================================================
// DATABASE OPERATIONS (Generic SQL Streaming)
// =============================================================================

export {
    DatabaseOps,
    collect,
    type Source,
    type DbRecord,
    type UpdateRecord,
} from './database-ops.js';

// =============================================================================
// ENTITY OPERATIONS (Entity-Aware Streaming with Observer Pipeline)
// =============================================================================

export {
    EntityOps,
    type EntityRecord,
    type EntitySystemContext,
    type UpsertOptions,
} from './entity-ops.js';

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

// =============================================================================
// SCHEMA LOADER
// =============================================================================

export {
    loadSchema,
    loadSchemaSync,
    type SchemaOps,
    type LoadResult,
} from './schema-loader.js';
