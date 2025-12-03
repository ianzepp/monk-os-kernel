/**
 * Model Layer - Public Exports
 *
 * This module re-exports the public API for the model layer, which provides:
 * - Database schema and connection management
 * - Observer pipeline for entity mutations
 *
 * USAGE
 * =====
 * ```typescript
 * import {
 *     createDatabase,
 *     createDatabaseConnection,
 *     ObserverRunner,
 *     ObserverRing,
 * } from '@src/model/index.js';
 *
 * const db = await createDatabase();
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
// OBSERVER PIPELINE
// =============================================================================

export {
    // Types
    ObserverRing,
    type OperationType,
    type ObserverResult,
    // Interfaces
    type Observer,
    type ObserverContext,
    type SystemContext,
    type Model,
    type ModelRecord,
    type FieldRow,
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
