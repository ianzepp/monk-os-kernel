/**
 * Field Sudo Validator - Field-Level Sudo Protection Observer
 *
 * Ensures that operations modifying sudo-protected fields require explicit sudo token.
 * This provides field-level granular security within models - allows regular operations
 * on most fields while protecting sensitive fields.
 *
 * Complements model-level sudo (SudoValidator) which protects entire models.
 * This validator allows fine-grained control: normal users can update most fields,
 * but changing sensitive fields (salary, pricing, security settings) requires sudo.
 *
 * Performance:
 * - Zero database queries: uses Model.getSudoFields() from cached field metadata
 * - O(m) where m=changed fields (typically small)
 * - Precalculated Set<string> for O(1) sudo field lookup
 *
 * Use cases:
 * - Salary fields in HR systems (update employee, but sudo for salary)
 * - Pricing fields in e-commerce (update product, but sudo for price)
 * - Security settings (update profile, but sudo for 2FA changes)
 * - Financial fields (update account, but sudo for credit limit)
 *
 * Ring 1 (Input Validation) - Priority 25 (after freeze, before immutable)
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { SecurityError } from '@src/lib/observers/errors.js';

export default class FieldSudoValidator extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;
    readonly operations = ['create', 'update'] as const;
    readonly priority = 25;

    async execute(context: ObserverContext): Promise<void> {
        const { model, system, record, operation } = context;
        const modelName = model.model_name;

        // Get sudo-protected fields from cached model metadata (O(1))
        const sudoFields = model.getSudoFields();

        // No sudo-protected fields defined - skip validation
        if (sudoFields.size === 0) {
            return;
        }

        // Check if user has sudo access (root, sudo token, or as_sudo flag)
        const hasSudo = system.isSudo();

        // Track which sudo fields are being modified
        const sudoFieldsModified: Set<string> = new Set();

        // Convert to plain object to iterate fields
        const plainRecord = record.toObject();

        // Check each field in the record
        for (const fieldName of Object.keys(plainRecord)) {
            // Skip non-sudo fields
            if (!sudoFields.has(fieldName)) {
                continue;
            }

            // Sudo field is being modified
            sudoFieldsModified.add(fieldName);
        }

        // If sudo fields are being modified but user lacks sudo token
        if (sudoFieldsModified.size > 0 && !hasSudo) {
            const fieldList = Array.from(sudoFieldsModified).join(', ');

            console.warn(`Blocked ${operation} on sudo-protected fields`, {
                modelName,
                operation,
                sudoFields: Array.from(sudoFieldsModified),
                recordIndex: context.recordIndex,
                userId: system.getUser?.()?.id
            });

            throw new SecurityError(
                `Cannot modify sudo-protected fields [${fieldList}] without sudo access. ` +
                `Use POST /api/user/sudo to get short-lived sudo token before modifying these fields.`,
                { fields: Array.from(sudoFieldsModified) }, // Context with affected fields
                'FIELD_REQUIRES_SUDO'
            );
        }

        // Either no sudo fields modified, or user has valid sudo token
        if (sudoFieldsModified.size > 0) {
            console.info('Sudo access validated for protected fields', {
                modelName,
                operation,
                sudoFields: Array.from(sudoFieldsModified),
                recordIndex: context.recordIndex,
                userId: system.getUser()?.id
            });
        }
    }
}
