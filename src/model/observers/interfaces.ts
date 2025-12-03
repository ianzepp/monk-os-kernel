/**
 * Observer Pipeline - Interfaces
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the contracts for observers in the pipeline. Every
 * observer implements the Observer interface, receives an ObserverContext,
 * and has access to system services via SystemContext.
 *
 * The context carries everything an observer needs:
 * - System services (database, cache)
 * - Operation details (type, model)
 * - Record being processed (with change tracking)
 * - Error/warning accumulation
 *
 * INVARIANTS
 * ==========
 * INV-1: ObserverContext.model is never null during pipeline execution
 * INV-2: ObserverContext.record is never null during pipeline execution
 * INV-3: Observer.execute() must not modify observer's own state (observers are reusable)
 * INV-4: Observers should not store references to context after execute() returns
 *
 * CONCURRENCY MODEL
 * =================
 * Observers execute sequentially within a single pipeline run. However, multiple
 * pipeline runs may occur concurrently (different requests). Observers must be
 * stateless or use only the provided context for state.
 *
 * @module model/observers/interfaces
 */

import type { ObserverRing, OperationType } from './types.js';
import type { EOBSINVALID } from './errors.js';

// =============================================================================
// FORWARD DECLARATIONS
// =============================================================================
// These types are defined in Phase 2/3. Using minimal interfaces here.

/**
 * Model metadata wrapper (defined in Phase 3).
 *
 * WHY interface here: Allows observer pipeline to be implemented and tested
 * before the full Model class exists. Phase 3 will provide the real implementation.
 */
export interface Model {
    /** Model name (e.g., 'invoice', 'customer') */
    readonly model_name: string;

    /** Is model frozen (no changes allowed)? */
    readonly isFrozen: boolean;

    /** Is model immutable (no updates, only create/delete)? */
    readonly isImmutable: boolean;

    /** Does model require sudo for changes? */
    readonly requiresSudo: boolean;

    /** Get field names that are immutable */
    getImmutableFields(): Set<string>;

    /** Get field names that are tracked for audit */
    getTrackedFields(): Set<string>;

    /** Get field names with transforms and their transform types */
    getTransformFields(): Map<string, string>;

    /** Get fields that need validation */
    getValidationFields(): FieldRow[];

    /** Get all fields */
    getFields(): FieldRow[];
}

/**
 * Field metadata row (defined in Phase 2).
 *
 * WHY minimal: Only includes fields needed by Phase 1 observers.
 * Full definition in Phase 2 schema.
 */
export interface FieldRow {
    field_name: string;
    type: string;
    is_array: boolean;
    required: boolean;
    default_value?: string | null;
    minimum?: number | null;
    maximum?: number | null;
    pattern?: string | null;
    enum_values?: string | null;
    immutable: boolean;
    transform?: string | null;
}

/**
 * Record with change tracking (defined in Phase 3).
 *
 * WHY interface here: Observers need to read/modify record data. This interface
 * defines the contract; Phase 3 provides ModelRecord implementation.
 */
export interface ModelRecord {
    /** Is this a new record (no original data)? */
    isNew(): boolean;

    /** Get original value (from database) */
    old(field: string): unknown;

    /** Get new value (from input) */
    new(field: string): unknown;

    /** Get merged value (new if changed, else original) */
    get(field: string): unknown;

    /** Check if field has a new value */
    has(field: string): boolean;

    /** Set a new value */
    set(field: string, value: unknown): void;

    /** Get all changed field names */
    getChangedFields(): string[];

    /** Get merged record for database operations */
    toRecord(): Record<string, unknown>;

    /** Get only the changes */
    toChanges(): Record<string, unknown>;

    /** Get diff for tracking: { field: { old, new } } */
    getDiff(): Record<string, { old: unknown; new: unknown }>;
}

// =============================================================================
// SYSTEM CONTEXT
// =============================================================================

/**
 * System services available to observers.
 *
 * WHY separate from ObserverContext: SystemContext is stable across all
 * observers in a pipeline run. ObserverContext has per-record state.
 *
 * WHY any types: Phase 3 will define proper Database and ModelCache types.
 * Using any here to avoid circular dependencies during bootstrap.
 */
export interface SystemContext {
    /**
     * Database connection for SQL operations.
     * Type: bun:sqlite Database (Phase 3 will type this properly)
     */
    db: unknown;

    /**
     * Model metadata cache.
     * Type: ModelCache (Phase 3 will define)
     */
    cache: unknown;
}

// =============================================================================
// OBSERVER CONTEXT
// =============================================================================

/**
 * Context passed to each observer during pipeline execution.
 *
 * WHY mutable errors/warnings: Ring 1 (validation) accumulates errors rather
 * than failing fast. Observers push to these arrays; runner checks after ring.
 *
 * WHY recordIndex: Supports batch operations where multiple records are
 * processed. Observer can use index for error messages or optimizations.
 */
export interface ObserverContext {
    /** System services (database, cache) */
    readonly system: SystemContext;

    /** Operation being performed */
    readonly operation: OperationType;

    /** Model being operated on */
    readonly model: Model;

    /** Record being processed (mutable - observers can modify) */
    readonly record: ModelRecord;

    /** Position in batch (0 for single-record operations) */
    readonly recordIndex: number;

    /** Accumulated validation errors (Ring 1 pushes here) */
    readonly errors: EOBSINVALID[];

    /** Accumulated warnings (any ring can push) */
    readonly warnings: string[];
}

// =============================================================================
// OBSERVER CONTRACT
// =============================================================================

/**
 * Observer contract - implemented by all observers.
 *
 * WHY readonly arrays for operations/models: Prevents accidental mutation.
 * Observer registration should not modify the observer's configuration.
 *
 * WHY optional models: Empty/undefined means observer runs for all models.
 * Useful for cross-cutting concerns like audit logging.
 */
export interface Observer {
    /** Observer name (for debugging and metrics) */
    readonly name: string;

    /** Ring this observer executes in */
    readonly ring: ObserverRing;

    /**
     * Priority within ring (lower = runs first).
     *
     * WHY number not enum: Allows fine-grained ordering without predefined
     * values. Convention: 10, 20, 30... leaving gaps for insertion.
     */
    readonly priority: number;

    /** Operations this observer handles */
    readonly operations: readonly OperationType[];

    /**
     * Models this observer handles (empty = all models).
     *
     * WHY optional: Most observers are generic (validation, SQL execution).
     * Model-specific observers (DDL for 'models' table) specify their targets.
     */
    readonly models?: readonly string[];

    /**
     * Execute observer logic.
     *
     * INVARIANTS:
     * - Must not modify observer's own state
     * - Must not store references to context
     * - Should complete within timeout (base class enforces)
     *
     * @param context - Execution context with model, record, system services
     * @throws ObserverError (or subclass) on failure
     */
    execute(context: ObserverContext): Promise<void>;
}
