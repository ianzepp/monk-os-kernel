/**
 * Model Sudo Access Validator - Model-Level Security Observer
 *
 * Ensures that operations on models marked with sudo=true require sudo access.
 * Sudo access is granted via:
 * - access='root' (automatic sudo, like Linux root user)
 * - is_sudo=true (explicit sudo token from POST /api/user/sudo)
 * - as_sudo=true (temporary self-service sudo flag)
 *
 * This provides:
 * - Data-driven model protection (checks models.sudo field)
 * - Audit trail for protected model operations
 * - Automatic sudo for root users (no extra step needed)
 * - Optional explicit elevation for audit trail
 *
 * Ring 1 (Input Validation) - Priority 20 (model-level security)
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SystemError } from '@src/lib/observers/errors.js';

export default class ModelSudoValidator extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;
    readonly operations = ['create', 'update', 'delete'] as const;
    readonly priority = 20;

    async execute(context: ObserverContext): Promise<void> {
        const { system, model } = context;

        // Don't apply sudo checks to model metadata operations (operations on the 'models' table itself)
        // The sudo flag protects DATA operations, not metadata operations
        // Model metadata operations already require root/admin privileges
        if (model.model_name === 'models') {
            return;
        }

        // Use cached model data - the model object comes from NamespaceCache
        const requiresSudo = model.sudo ?? false;

        if (!requiresSudo) {
            // Model doesn't require sudo - allow normal processing
            return;
        }

        console.info('Validating sudo access for protected model', {
            operation: context.operation,
            modelName: model.model_name,
            recordIndex: context.recordIndex
        });

        // Use system.isSudo() which checks: root user, is_sudo token, or as_sudo flag
        if (!system.isSudo()) {
            throw new SystemError(
                `Model '${model.model_name}' requires sudo access. Root users have automatic access, others must use POST /api/user/sudo.`
            );
        }

        console.info('Sudo access validated for protected model', {
            operation: context.operation,
            modelName: model.model_name,
            recordIndex: context.recordIndex,
            userId: system.getUser()?.id
        });
    }
}
