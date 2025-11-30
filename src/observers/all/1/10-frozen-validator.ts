/**
 * Freeze Validator - Model-Level Data Protection Observer
 *
 * Prevents all data operations (create, update, delete) on models marked with frozen=true.
 * This provides emergency "circuit breaker" functionality to temporarily lock down models
 * during incidents or maintenance windows.
 *
 * Performance:
 * - Zero database queries: uses Model.isFrozen() which reads from cached model metadata
 * - O(1) check: single boolean flag check per operation
 *
 * Use cases:
 * - Emergency data protection during security incidents
 * - Maintenance windows requiring read-only access
 * - Regulatory compliance freeze periods
 * - Preventing modifications during audits
 *
 * Ring 1 (Input Validation) - Priority 10 (highest - first security check)
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SecurityError } from '@src/lib/observers/errors.js';

export default class FrozenValidator extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;
    readonly operations = ['create', 'update', 'delete'] as const;
    readonly priority = 10;

    async execute(context: ObserverContext): Promise<void> {
        const { model, operation } = context;

        // Use cached model metadata - zero DB queries
        if (model.isFrozen()) {
            const modelName = model.model_name;

            console.warn(`Blocked ${operation} on frozen model`, {
                modelName,
                operation,
                recordIndex: context.recordIndex,
                frozen: true
            });

            throw new SecurityError(
                `Model '${modelName}' is frozen. All data operations are temporarily disabled. ` +
                `Contact your administrator to unfreeze this model.`,
                undefined, // No specific field
                'MODEL_FROZEN'
            );
        }

        // Model not frozen - allow operation to continue
    }
}
