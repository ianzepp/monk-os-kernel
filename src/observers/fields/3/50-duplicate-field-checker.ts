/**
 * Duplicate Field Checker - Ring 3 Business Logic
 *
 * Checks if a field with the same name already exists in the model.
 * Provides better error message than database unique constraint violation.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class DuplicateFieldChecker extends BaseObserver {
    readonly ring = ObserverRing.Business;  // Ring 3
    readonly operations = ['create'] as const;
    readonly models = ['fields'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { model_name, field_name } = record;

        if (!model_name || !field_name) {
            return; // Required field validation handled elsewhere
        }

        // Check if field already exists in this model
        const result = await SqlUtils.getPool(system).query(
            'SELECT field_name FROM fields WHERE model_name = $1 AND field_name = $2 LIMIT 1',
            [model_name, field_name]
        );

        if (result.rows.length > 0) {
            throw new ValidationError(
                `Field '${field_name}' already exists in model '${model_name}'`,
                'field_name'
            );
        }
    }
}
