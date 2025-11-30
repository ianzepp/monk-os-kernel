/**
 * Observer Framework Interfaces
 *
 * Core interfaces for the observer ring system including context sharing,
 * observer definitions, and execution contracts.
 */

import type { SystemContext } from '@src/lib/system-context-types.js';
import type { Model } from '@src/lib/model.js';
import type { ModelRecord } from '@src/lib/model-record.js';
import type {
    ObserverRing,
    OperationType,
    ObserverResult
} from '@src/lib/observers/types.js';
import type { ValidationError, ValidationWarning } from '@src/lib/observers/errors.js';
import type { DatabaseType } from '@src/lib/database/adapter.js';

/**
 * Shared context passed through all observer rings
 * Contains request state, data, and cross-observer communication
 *
 * Single-record model: Each observer receives one record at a time.
 * The ObserverRunner handles iteration over the batch.
 */
export interface ObserverContext {
    /** Per-request database system context */
    system: SystemContext;

    /** Database operation being performed */
    operation: OperationType;

    /** Loaded Model object with validation and metadata */
    model: Model;

    /** Single record being processed (wrapped in ModelRecord instance) */
    record: ModelRecord;

    /** Index of this record in the original batch (for error messages) */
    recordIndex: number;

    /** Accumulated validation errors from all rings */
    errors: ValidationError[];

    /** Accumulated non-blocking warnings from all rings */
    warnings: ValidationWarning[];

    /** Start time for performance tracking */
    startTime: number;

    /** Current ring being executed (for debugging) */
    currentRing?: ObserverRing;

    /** Current observer being executed (for debugging) */
    currentObserver?: string;
}

/**
 * Base observer interface that all observers must implement
 */
export interface Observer {
    /** Which ring this observer executes in */
    ring: ObserverRing;

    /** Optional: limit to specific operations (default: all operations) */
    operations?: readonly OperationType[];

    /** Optional: limit to specific database adapters (default: runs on all adapters)
     *  Use this to create adapter-specific observers, e.g., adapters: ['postgresql']
     *  for observers that use PostgreSQL-specific SQL features like RETURNING */
    adapters?: readonly DatabaseType[];

    /** Optional: limit to specific models (default: runs on all models)
     *  Use 'all' or omit to run on all models, or specify model names like ['users', 'posts'] */
    models?: readonly string[];

    /** Optional: execution priority within a ring (lower numbers execute first, default: 50) */
    priority?: number;

    /** Optional: observer name for debugging and error reporting */
    name?: string;

    /** Optional: timeout in milliseconds (default: 5000ms) */
    timeout?: number;

    /**
     * Public method with error handling, logging, and timeout protection
     * @param context Shared context with request data and state
     */
    executeTry(context: ObserverContext): Promise<void>;

    /**
     * Pure business logic method - implement this in your observer
     * @param context Shared context with request data and state
     */
    execute(context: ObserverContext): Promise<void>;
}

/**
 * Observer class constructor interface for dynamic loading
 */
export interface ObserverConstructor {
    new(): Observer;
}

/**
 * Observer execution statistics for monitoring
 */
export interface ObserverStats {
    observerName: string;
    ring: ObserverRing;
    model: string;
    operation: OperationType;
    executionTimeMs: number;
    success: boolean;
    errorCount: number;
    warningCount: number;
}

/**
 * Observer execution summary for a complete operation
 */
export interface ObserverExecutionSummary {
    model: string;
    operation: OperationType;
    totalTimeMs: number;
    ringsExecuted: ObserverRing[];
    observersExecuted: number;
    totalErrors: number;
    totalWarnings: number;
    success: boolean;
    stats: ObserverStats[];
}
