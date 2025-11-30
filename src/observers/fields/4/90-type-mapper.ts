/**
 * Type Mapper Observer - Ring 4 Enrichment
 *
 * Maps user-facing type names to PostgreSQL field_type enum values just before
 * database operations (Ring 5). This ensures that:
 *
 * - Rings 1-3 (validation, security, business logic) work with user-friendly types
 * - Ring 4 transforms data for database storage
 * - Ring 5 database operations see PostgreSQL types
 * - Ring 6 DDL observers receive PostgreSQL types (no mapping needed)
 * - Ring 6 type unmapper converts back to user types for API responses
 *
 * Type conversion is bidirectional:
 * - User → PG: Ring 4 type-mapper (this observer)
 * - PG → User: Ring 6 type-unmapper (runs on all operations that return data)
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import { USER_TO_PG_TYPE_MAP, VALID_USER_TYPES } from '@src/lib/field-types.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class TypeMapperObserver extends BaseObserver {
    readonly ring = ObserverRing.Enrichment;  // Ring 4
    readonly operations = ['create', 'update'] as const;
    readonly adapters = ['postgresql'] as const;  // Maps to PostgreSQL types
    readonly models = ['fields'] as const;
    readonly priority = 90;  // Run late in Ring 4, just before database (Ring 5)

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { type } = record;

        if (!type) {
            return; // Skip if no type field
        }

        const userType = type;
        const pgType = USER_TO_PG_TYPE_MAP[userType];

        if (!pgType) {
            throw new ValidationError(
                `Invalid type '${userType}'. Valid types: ${VALID_USER_TYPES.join(', ')}`,
                'type'
            );
        }

        // Map user-facing type to PostgreSQL type
        record.type = pgType;
    }
}
