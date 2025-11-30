/**
 * External Model Guard Observer - Ring 0 PreValidation
 *
 * Rejects any create/update/delete operations on external models.
 * External models are documented in the system but managed by specialized APIs.
 * This runs in Ring 0 to protect ALL code paths (API and internal).
 */
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SecurityError } from '@src/lib/observers/errors.js';

export default class ExternalModelGuard extends BaseObserver {
    readonly ring = ObserverRing.DataPreparation; // Ring 0
    readonly operations = ['create', 'update', 'delete'] as const;
    readonly priority = 5; // Early execution, before most validation

    async execute(context: ObserverContext): Promise<void> {
        const { model } = context;
        const modelName = model.model_name;

        // Check if model is external
        if (model.external === true) {
            throw new SecurityError(
                `Model '${modelName}' is externally managed and cannot be modified via Data API. Use the appropriate specialized API instead.`,
                { modelName },
                'MODEL_EXTERNAL'
            );
        }

        // Model is internal, allow operation to continue
    }
}
