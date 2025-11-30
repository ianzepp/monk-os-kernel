/**
 * Type Unmapper Observer - Ring 6 PostDatabase
 *
 * Maps PostgreSQL field_type values back to user-facing type names for ALL operations
 * that return field data (select, create, update, delete).
 *
 * This ensures API responses always show user-friendly type names (e.g., "decimal")
 * instead of PostgreSQL-specific names (e.g., "numeric").
 *
 * ## Why No TypeMapper in Ring 6?
 *
 * Type mapping is UNIDIRECTIONAL in the observer pipeline:
 *
 * **Incoming (User → Database):**
 * - Ring 4 type-mapper converts user types → PG types BEFORE database write
 * - Ring 5 database writes PG types to fields table
 * - Ring 6 DDL observers receive PG types (no mapping needed!)
 *
 * **Outgoing (Database → User):**
 * - Ring 5 database reads PG types from fields table
 * - Ring 6 type-unmapper converts PG types → user types AFTER database read
 * - API responses show user-friendly types
 *
 * This architecture ensures:
 * - Rings 1-3 work with user types (validation, security, business logic)
 * - Ring 4 transforms user types → PG types (enrichment)
 * - Ring 5 only sees PG types (database operations)
 * - Ring 6 DDL uses PG types directly (no mapping needed)
 * - Ring 6 unmapper restores user types for API responses
 * - Single source of truth for type mappings (DRY principle)
 *
 * Paired with Ring 4 type-mapper.ts which does the forward mapping.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import type { ModelRecord } from '@src/lib/model-record.js';

/**
 * Map PostgreSQL field_type values back to user-facing type names
 */
const REVERSE_TYPE_MAPPING: Record<string, string> = {
    // Scalar types
    'text': 'text',
    'integer': 'integer',
    'numeric': 'decimal',      // PostgreSQL "numeric" maps back to user-facing "decimal"
    'boolean': 'boolean',
    'timestamp': 'timestamp',
    'date': 'date',
    'uuid': 'uuid',
    'jsonb': 'jsonb',

    // Array types
    'text[]': 'text[]',
    'integer[]': 'integer[]',
    'numeric[]': 'decimal[]',  // PostgreSQL "numeric[]" maps back to user-facing "decimal[]"
    'uuid[]': 'uuid[]',
} as const;

export default class TypeUnmapperObserver extends BaseObserver {
    readonly ring = ObserverRing.PostDatabase;  // Ring 6
    readonly operations = ['create', 'update', 'delete'] as const;  // All write operations that return data
    readonly adapters = ['postgresql'] as const;  // Maps PostgreSQL type names
    readonly models = ['fields'] as const;
    readonly priority = 80;  // Run after DDL observers (priority 10)

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { model_name, field_name, type } = record;

        if (!type) {
            return; // Skip if no type field
        }

        const pgType = type;
        const userType = REVERSE_TYPE_MAPPING[pgType];

        if (userType) {
            // Map PostgreSQL type back to user-facing type
            record.type = userType;
        } else {
            // Unknown type - log warning but don't fail
            console.warn('Unknown PostgreSQL type encountered in type unmapping', {
                pgType,
                model_name,
                field_name
            });
            // Keep original value
        }
    }
}
