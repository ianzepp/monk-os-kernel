/**
 * Duplicate Model Checker - Ring 3 Business Logic
 *
 * Checks if a model with the same name already exists in the database.
 * Provides better error message than database unique constraint violation.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import { SqlUtils } from '@src/lib/observers/sql-utils.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class DuplicateModelChecker extends BaseObserver {
    readonly ring = ObserverRing.Business;  // Ring 3
    readonly operations = ['create'] as const;
    readonly models = ['models'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, record } = context;
        const { model_name } = record;

        if (!model_name) {
            return; // Required field validation handled elsewhere
        }

        // Check if model already exists
        const result = await SqlUtils.getPool(system).query(
            'SELECT model_name FROM models WHERE model_name = $1 LIMIT 1',
            [model_name]
        );

        if (result.rows.length > 0) {
            throw new ValidationError(
                `Model '${model_name}' already exists`,
                'model_name'
            );
        }
    }
}
