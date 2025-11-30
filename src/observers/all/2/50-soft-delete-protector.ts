/**
 * Soft Delete Protector Observer
 *
 * Prevents operations on records that have been soft deleted (trashed_at is not null).
 * Uses ModelRecord.old() to check trashed status from original data loaded by record preloading.
 *
 * This enforces the three-tier soft delete access pattern:
 * - List operations: Hide trashed records (handled by query filters)
 * - Direct access: Allow ID retrieval of trashed records (GET /api/data/:model/:id)
 * - Update operations: Block modifications until restoration (this observer)
 *
 * Ring: 2 (Security) - Model: all - Operations: update, delete
 */

import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { SecurityError } from '@src/lib/observers/errors.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { ObserverRing } from '@src/lib/observers/types.js';

export default class SoftDeleteProtector extends BaseObserver {
    readonly ring = ObserverRing.Security;
    readonly operations = ['update', 'delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { operation, record } = context;
        const modelName = context.model.model_name;
        const recordId = record.get('id');

        // Check if record exists (has original data from record preloading)
        if (record.isNew()) {
            // Record doesn't exist - let ExistenceValidator handle this
            return;
        }

        // Check if record is trashed (soft deleted)
        const trashedAt = record.old('trashed_at');
        if (trashedAt !== null && trashedAt !== undefined) {
            console.warn(`Blocked ${operation} on trashed record`, {
                modelName,
                operation,
                recordId,
                recordIndex: context.recordIndex,
                trashedAt
            });

            throw new SecurityError(
                `Cannot ${operation} trashed record: ${recordId}. Use revert operation to restore before modification.`,
                undefined,
                'SOFT_DELETE_PROTECTION'
            );
        }

        // Check if record is hard deleted
        const deletedAt = record.old('deleted_at');
        if (deletedAt !== null && deletedAt !== undefined) {
            console.warn(`Blocked ${operation} on deleted record`, {
                modelName,
                operation,
                recordId,
                recordIndex: context.recordIndex,
                deletedAt
            });

            throw new SecurityError(
                `Cannot ${operation} permanently deleted record: ${recordId}. This record cannot be modified.`,
                undefined,
                'HARD_DELETE_PROTECTION'
            );
        }
    }
}
