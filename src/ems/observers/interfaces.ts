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
import type { DatabaseDialect } from '../dialect.js';

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
    readonly modelName: string;

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

    /** Get diff filtered to specific fields only */
    getDiffForFields(fields: Set<string>): Record<string, { old: unknown; new: unknown }>;
}

/**
 * Database connection for SQL operations (defined in Phase 2).
 *
 * WHY interface here: Ring 5 observers need to execute SQL but shouldn't
 * import DatabaseConnection directly (circular dependency). This minimal
 * interface defines only what observers need.
 *
 * The actual DatabaseConnection class in connection.ts provides additional
 * methods (query, queryOne, exec, close) not needed by observers.
 */
export interface DatabaseAdapter {
    /**
     * Database dialect for SQL generation and type conversion.
     *
     * WHY: Observers need dialect for placeholder syntax (? vs $1),
     * type mapping, and DDL generation.
     */
    readonly dialect: DatabaseDialect;

    /**
     * Execute an INSERT/UPDATE/DELETE statement.
     *
     * @param sql - SQL statement with placeholders (dialect-specific)
     * @param params - Parameter values (positional)
     * @returns Promise resolving to affected row count
     * @throws Error on execution failure
     */
    execute(sql: string, params?: unknown[]): Promise<number>;

    /**
     * Execute a SELECT query and return all rows.
     *
     * @param sql - SQL SELECT statement
     * @param params - Query parameters (positional)
     * @returns Promise resolving to array of rows
     */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

    /**
     * Execute raw SQL (multiple statements allowed).
     *
     * @param sql - Raw SQL (may contain multiple statements)
     */
    exec(sql: string): Promise<void>;

    /**
     * Execute multiple statements in a single atomic transaction.
     *
     * @param statements - Array of SQL statements with optional params
     * @returns Promise resolving to array of affected row counts (one per statement)
     * @throws Error on transaction failure (already rolled back)
     */
    transaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<number[]>;
}

/**
 * Model cache for metadata lookup (defined in Phase 3).
 *
 * WHY interface here: Ring 8 (CacheInvalidator) needs to invalidate cache
 * entries without importing ModelCache directly.
 */
export interface ModelCacheAdapter {
    /**
     * Invalidate cached model metadata.
     *
     * @param modelName - Model to invalidate
     */
    invalidate(modelName: string): void;
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
 * The db and cache properties use adapter interfaces defined above to avoid
 * circular dependencies with the actual implementation classes.
 */
export interface SystemContext {
    /**
     * Database connection for SQL operations.
     *
     * Provides execute() for INSERT/UPDATE/DELETE, query() for SELECT,
     * and exec() for raw multi-statement SQL (DDL).
     */
    db: DatabaseAdapter;

    /**
     * Model metadata cache.
     *
     * Provides invalidate() for cache management after model/field changes.
     */
    cache: ModelCacheAdapter;
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
