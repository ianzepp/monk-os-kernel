/**
 * Immutable Fields Validator - Field-Level Write Protection Observer
 *
 * Prevents modifications to fields marked with immutable=true once they have been set.
 * Fields can be set during creation or their first update, but subsequent changes are blocked.
 *
 * Performance:
 * - Zero database queries: uses Model.getImmutableFields() from cached field metadata
 * - O(n) field check: iterates over changed fields only (not all fields)
 * - Uses ModelRecord.old() to access original values loaded by record preloading
 *
 * Use cases:
 * - Audit fields (created_by, created_at) that should never change
 * - Regulatory identifiers (SSN, account numbers) that are write-once
 * - Historical data preservation (original_price, initial_status)
 * - Blockchain-style immutability for critical fields
 *
 * Ring 1 (Input Validation) - Priority 30 (after freeze check, before business logic)
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';

export default class ImmutableValidator extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;
    readonly operations = ['update'] as const;
    readonly priority = 30;

    async execute(context: ObserverContext): Promise<void> {
        const { model, record } = context;
        const modelName = model.model_name;

        // Get immutable fields from cached model metadata (O(1))
        const immutableFields = model.getImmutableFields();

        // No immutable fields defined - skip validation
        if (immutableFields.size === 0) {
            return;
        }

        // Check if record has original data (should be loaded by record preloading in Database)
        if (record.isNew()) {
            // New records don't have immutability constraints
            return;
        }

        const recordId = record.get('id');
        const violations: Array<{ field: string; oldValue: any; newValue: any }> = [];

        // Get only the fields being changed in this update
        const changedFields = record.getChangedFields();

        // Check each changed field for immutability violations
        for (const fieldName of changedFields) {
            // Skip non-immutable fields
            if (!immutableFields.has(fieldName)) {
                continue;
            }

            const oldValue = record.old(fieldName);
            const newValue = record.new(fieldName);

            // Allow setting immutable field if it was null/undefined (first write)
            if (oldValue === null || oldValue === undefined) {
                console.info('Allowing first write to immutable field', {
                    modelName,
                    recordId,
                    recordIndex: context.recordIndex,
                    field: fieldName,
                    newValue
                });
                continue;
            }

            // Check if value is actually changing (deep comparison for objects/arrays)
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                violations.push({
                    field: fieldName,
                    oldValue,
                    newValue
                });
            }
        }

        // If violations found, throw detailed error
        if (violations.length > 0) {
            const violationSummary = violations
                .map(v => `${v.field} (was: ${JSON.stringify(v.oldValue)}, attempted: ${JSON.stringify(v.newValue)})`)
                .join('; ');

            console.warn('Blocked update to immutable fields', {
                modelName,
                recordId,
                recordIndex: context.recordIndex,
                violations: violations.length,
                details: violations
            });

            throw new ValidationError(
                `Cannot modify immutable field${violations.length > 1 ? 's' : ''} on record ${recordId}: ${violationSummary}`,
                violations[0].field // First violated field
            );
        }
    }
}
