/**
 * Observer Ring System Types
 *
 * Defines the ring-based execution model for the observer system.
 * Observers execute in ordered rings 0-9, with ring 5 designated for database operations.
 */

/**
 * Observer execution rings (0-9) with semantic assignments
 */
export enum ObserverRing {
    DataPreparation = 0, // Data loading, merging, input preparation
    InputValidation = 1, // Model validation, format checks, basic integrity
    Security = 2,        // Access control, protection policies, rate limiting
    Business = 3,        // Complex business logic, domain rules, workflows
    Enrichment = 4,      // Data enrichment, defaults, computed fields
    Database = 5,        // 🎯 DATABASE RING - SQL execution
    PostDatabase = 6,    // Immediate post-database processing
    Audit = 7,           // Audit logging, change tracking, compliance
    Integration = 8,     // External APIs, webhooks, cache invalidation
    Notification = 9     // User notifications, email alerts, real-time updates
}

/**
 * Database ring constant for easy reference
 */
export const DATABASE_RING = ObserverRing.Database;

/**
 * Database operation types that observers can target
 * - create: Insert new records
 * - update: Modify existing records
 * - delete: Soft delete records (set trashed_at)
 * - revert: Undo soft delete (clear trashed_at)
 * - expire: Permanent delete records (set deleted_at)
 * - access: Modify access control lists (ACLs only)
 *
 * Note: 'select' is NOT an operation type. Selects bypass the observer pipeline
 * entirely and go directly through Database.selectAny(). This is because selects:
 * - Don't modify data (no need for validation rings)
 * - Don't fit the single-record pipeline model (return multiple records)
 * - Perform better without observer overhead
 */
export type OperationType = 'create' | 'update' | 'delete' | 'revert' | 'expire' | 'access';

/**
 * Ring execution matrix - defines which rings execute for each operation type
 *
 * This optimizes performance by skipping irrelevant rings for certain operations.
 */
export const RING_OPERATION_MATRIX = {
    'create': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],  // ALL rings
    'update': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],  // ALL rings
    'delete': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],  // ALL rings
    'revert': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],  // ALL rings - undoing soft deletes
    'expire': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],  // ALL rings - permanent delete
    'access': [0, 1, 2, 5, 6, 7, 8, 9],        // Skip enrichment (ring 4), skip business logic (ring 3) - ACL-only operation
} as const;

/**
 * Result of observer execution
 */
export interface ObserverResult {
    success: boolean;
    result?: any;
    errors: any[]; // ValidationError instances from errors.js
    warnings: any[]; // ValidationWarning instances from errors.js
}

/**
 * Universal model targeting keyword
 * Used to indicate an observer applies to all models
 */
export const UNIVERSAL_MODEL_KEYWORD = 'all' as const;
export type UniversalModelKeyword = typeof UNIVERSAL_MODEL_KEYWORD;
