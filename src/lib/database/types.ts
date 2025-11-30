/**
 * Database Service Types
 *
 * Types and interfaces for the high-level Database service class.
 * These are distinct from the low-level adapter types and record types.
 */

import type { FilterWhereOptions } from '@src/lib/filter-types.js';

/**
 * Relationship metadata returned by getRelationship()
 */
export interface CachedRelationship {
    fieldName: string;      // Foreign key field on child model
    childModel: string;     // Child model name
    relationshipType: string; // 'owned', 'referenced', etc.
}

/**
 * Options for database select operations with context-aware soft delete handling
 */
export interface SelectOptions extends FilterWhereOptions {
    context?: 'api' | 'observer' | 'system';
}
