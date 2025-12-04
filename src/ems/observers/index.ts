/**
 * Observer Pipeline - Public Exports
 *
 * This module re-exports the public API for the observer pipeline.
 *
 * USAGE
 * =====
 * ```typescript
 * import {
 *     ObserverRunner,
 *     createObserverRunner,
 *     ObserverRing,
 *     BaseObserver,
 *     ValidationError,
 * } from '@src/ems/observers/index.js';
 * ```
 *
 * @module model/observers
 */

// =============================================================================
// TYPES
// =============================================================================

export {
    ObserverRing,
    type OperationType,
    type ObserverResult,
} from './types.js';

// =============================================================================
// INTERFACES
// =============================================================================

export type {
    Observer,
    ObserverContext,
    SystemContext,
    Model,
    ModelRecord,
    FieldRow,
} from './interfaces.js';

// =============================================================================
// ERRORS
// =============================================================================

export {
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
} from './errors.js';

// =============================================================================
// BASE CLASS
// =============================================================================

export { BaseObserver } from './base-observer.js';

// =============================================================================
// RUNNER
// =============================================================================

export { ObserverRunner } from './runner.js';

// =============================================================================
// REGISTRY
// =============================================================================

export { createObserverRunner } from './registry.js';

// =============================================================================
// OBSERVER IMPLEMENTATIONS
// =============================================================================
// Ring 5: Database Operations
export { SqlCreate, SqlUpdate, SqlDelete } from '../ring/5/index.js';

// Export the adapter interfaces for typing
export type { DatabaseAdapter, ModelCacheAdapter } from './interfaces.js';
