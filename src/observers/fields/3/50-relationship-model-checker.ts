/**
 * Relationship Model Checker - Ring 3 Business Logic
 *
 * Validates that related_model exists when creating a relationship field.
 * Ensures referential integrity before DDL execution.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class RelationshipModelChecker extends BaseObserver {
    readonly ring = ObserverRing.Business;  // Ring 3
    readonly operations = ['create', 'update'] as const;
    readonly models = ['fields'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { relationship_type, related_model, relationship_name } = record.toObject();

        // Skip if not a relationship field
        if (!relationship_type) {
            return;
        }

        // Validate required relationship fields
        if (!related_model) {
            throw new ValidationError(
                'related_model is required when relationship_type is set',
                'related_model'
            );
        }

        if (!relationship_name) {
            throw new ValidationError(
                'relationship_name is required when relationship_type is set',
                'relationship_name'
            );
        }

        // Validate relationship_type value
        if (!['owned', 'referenced'].includes(relationship_type)) {
            throw new ValidationError(
                `Invalid relationship_type '${relationship_type}'. Must be 'owned' or 'referenced'`,
                'relationship_type'
            );
        }

        // Check if related model exists
        const result = await SqlUtils.getPool(system).query(
            'SELECT model_name FROM models WHERE model_name = $1 AND status IN ($2, $3) LIMIT 1',
            [related_model, 'active', 'system']
        );

        if (result.rows.length === 0) {
            throw new ValidationError(
                `Related model '${related_model}' does not exist or is not active`,
                'related_model'
            );
        }
    }
}
