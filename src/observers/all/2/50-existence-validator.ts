/**
 * Existence Validator Observer
 *
 * Validates that the requested record exists before performing update, delete, or revert operations.
 * Uses ModelRecord.isNew() to check if original data was loaded by record preloading.
 *
 * Ensures data integrity by preventing operations on non-existent records, providing clear
 * error messages about which records are missing.
 *
 * Ring: 2 (Security) - Model: all - Operations: update, delete, revert
 */

import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { BusinessLogicError } from '@src/lib/observers/errors.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { ObserverRing } from '@src/lib/observers/types.js';

export default class ExistenceValidator extends BaseObserver {
    readonly ring = ObserverRing.Security;
    readonly operations = ['update', 'delete', 'revert'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { operation, record } = context;
        const modelName = context.model.model_name;
        const recordId = record.get('id');

        // Check if record exists in database (record preloading loads original data)
        if (record.isNew()) {
            console.warn(`${operation} operation failed - record not found`, {
                modelName,
                operation,
                recordId,
                recordIndex: context.recordIndex
            });

            throw new BusinessLogicError(
                `Cannot ${operation} - record not found: ${recordId}`,
                undefined,
                'RECORD_NOT_FOUND'
            );
        }

        // Special handling for revert operations - check that record is actually trashed
        if (operation === 'revert') {
            const trashedAt = record.old('trashed_at');

            if (trashedAt === null || trashedAt === undefined) {
                console.warn('Revert operation failed - record is not trashed', {
                    modelName,
                    recordId,
                    recordIndex: context.recordIndex,
                    trashedAt
                });

                throw new BusinessLogicError(
                    `Cannot revert non-trashed record: ${recordId}. Only trashed records can be reverted.`,
                    undefined,
                    'CANNOT_REVERT_NON_TRASHED'
                );
            }
        }
    }
}
