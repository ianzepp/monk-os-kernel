/**
 * Observer Pipeline - Type Definitions
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The observer pipeline is the core enforcement mechanism for all database
 * mutations in Monk OS. All create/update/delete operations flow through a
 * 10-ring pipeline where each ring has a specific semantic purpose.
 *
 * The ring system provides ordered, predictable execution:
 * - Rings 0-4: Pre-database (validation, transformation)
 * - Ring 5: Database execution
 * - Rings 6-9: Post-database (DDL, audit, integration, events)
 *
 * RING EXECUTION ORDER
 * ====================
 * ```
 * Ring 0: Data Preparation     ─┐
 * Ring 1: Input Validation      │ Pre-database
 * Ring 2: Security              │ (can reject)
 * Ring 3: Business Logic        │
 * Ring 4: Enrichment           ─┘
 * Ring 5: Database             ─── SQL execution
 * Ring 6: Post-Database        ─┐
 * Ring 7: Audit                 │ Post-database
 * Ring 8: Integration           │ (observe only)
 * Ring 9: Notification         ─┘
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: Rings execute in ascending order (0 → 9), never skipped
 * INV-2: Within a ring, observers execute by priority (lower first)
 * INV-3: Ring 1 (validation) errors accumulate; other rings fail-fast
 * INV-4: Post-database rings (6-9) cannot reject the operation
 *
 * @module model/observers/types
 */

// =============================================================================
// RING DEFINITIONS
// =============================================================================

/**
 * Observer ring assignments.
 *
 * WHY 10 rings: Provides clear separation of concerns while allowing fine-grained
 * ordering. The gap between conceptual phases (validation vs database vs audit)
 * allows future rings to be inserted if needed.
 *
 * WHY explicit numbers: Makes ring order unambiguous and allows direct comparison
 * (e.g., `ring < ObserverRing.Database` means "pre-database").
 */
export enum ObserverRing {
    /**
     * Ring 0: Data Preparation
     * Merge input with existing data, apply defaults.
     */
    DataPreparation = 0,

    /**
     * Ring 1: Input Validation
     * Type checking, constraints, required fields.
     * SPECIAL: Errors in this ring accumulate rather than fail-fast.
     */
    InputValidation = 1,

    /**
     * Ring 2: Security
     * Existence checks, soft-delete protection, permission validation.
     */
    Security = 2,

    /**
     * Ring 3: Business Logic
     * Custom business rules, cross-field validation.
     */
    BusinessLogic = 3,

    /**
     * Ring 4: Enrichment
     * Auto-transforms (lowercase, trim), computed fields.
     */
    Enrichment = 4,

    /**
     * Ring 5: Database
     * Actual SQL execution (INSERT, UPDATE, DELETE).
     * This is the point of no return for the operation.
     */
    Database = 5,

    /**
     * Ring 6: Post-Database
     * DDL operations (CREATE TABLE, ALTER TABLE) for schema changes.
     */
    PostDatabase = 6,

    /**
     * Ring 7: Audit
     * Change tracking, logging, history recording.
     */
    Audit = 7,

    /**
     * Ring 8: Integration
     * Cache invalidation, webhooks, external system notifications.
     */
    Integration = 8,

    /**
     * Ring 9: Notification
     * Internal events, triggers, pub/sub notifications.
     */
    Notification = 9,
}

// =============================================================================
// OPERATION TYPES
// =============================================================================

/**
 * Operations that can be observed.
 *
 * WHY only three: These are the fundamental mutation types. Read operations
 * bypass the observer pipeline entirely for performance.
 *
 * FUTURE: May add 'revert' (undo soft-delete) and 'expire' (hard delete)
 * if soft-delete/trash functionality is implemented.
 */
export type OperationType = 'create' | 'update' | 'delete';

// =============================================================================
// OBSERVER RESULTS
// =============================================================================

/**
 * Result of a single observer execution.
 *
 * WHY track duration: Allows identifying slow observers that may need
 * optimization or splitting into async post-processing.
 *
 * WHY separate warnings: Allows observers to report non-fatal issues
 * without failing the operation. Warnings are collected and can be
 * returned to the caller.
 */
export interface ObserverResult {
    /** Observer name (for debugging and metrics) */
    observer: string;

    /** Ring the observer ran in */
    ring: ObserverRing;

    /** Execution duration in milliseconds */
    duration: number;

    /** Error if observer failed (causes pipeline to abort, except Ring 1) */
    error?: Error;

    /** Non-fatal warnings generated during execution */
    warnings?: string[];
}
