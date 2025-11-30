/**
 * System Model Validator - On "models"
 *
 * TODO: Add description of what this observer does
 *
 * Performance:
 * - TODO: Document performance characteristics
 *
 * Use cases:
 * - TODO: Document use cases
 *
 * Ring 1 (Input Validation) - Priority 10
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';
import { SYSTEM_MODELS } from '@src/lib/model.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class ModelSystemModelValidator extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;
    readonly operations = ['create', 'update', 'delete'] as const;
    readonly models = ['models'] as const;
    readonly priority = 10;

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { model_name } = record;

        if (SYSTEM_MODELS.has(model_name) === false) {
            return;
        }

        throw new SystemError(
            `Model "${model_name}" is restricted and cannot be created, updated, or deleted`
        );
    }
}
