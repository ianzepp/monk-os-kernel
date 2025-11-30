/**
 * Transform Processor Observer
 *
 * Applies automatic data transformations to fields based on their transform field setting.
 * Runs in Ring 4 (Enrichment) after all validation passes.
 *
 * Supported transforms:
 * - lowercase: Convert string to lowercase
 * - uppercase: Convert string to UPPERCASE
 * - trim: Remove leading/trailing whitespace
 * - normalize_phone: Normalize phone number format (remove non-digits, keep + prefix)
 * - normalize_email: Lowercase and trim email addresses
 *
 * Performance:
 * - Only processes fields with transform metadata (O(1) Map lookup)
 * - Modifies record data in-place (zero allocations)
 * - Early exit if model has no transform fields
 *
 * Ring 4 (Enrichment) - Priority 50
 * Operations: create, update
 */

import { BaseObserver } from '@src/lib/observers/base-observer.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { ObserverRing } from '@src/lib/observers/types.js';

export default class TransformProcessor extends BaseObserver {
    readonly ring = ObserverRing.Enrichment;
    readonly operations = ['create', 'update'] as const;
    readonly priority = 50;

    async execute(context: ObserverContext): Promise<void> {
        const { model, record } = context;

        const transformFields = model.getTransformFields();

        // Early exit if no transform fields defined
        if (transformFields.size === 0) {
            return;
        }

        // Apply transforms for each field with a transform rule
        for (const [fieldName, transformType] of transformFields) {
            // Skip if field not being set in this operation (only transform new values)
            const value = record.new(fieldName);
            if (value === null || value === undefined) {
                continue;
            }

            // Apply transform and update field in-place
            const transformedValue = applyTransform(value, transformType);

            if (transformedValue !== value) {
                record.set(fieldName, transformedValue);
            }
        }
    }
}

/**
 * Apply a transformation to a field value
 *
 * @param value - The original value
 * @param transformType - Type of transform to apply
 * @returns Transformed value
 */
function applyTransform(value: any, transformType: string): any {
    // Convert to string for all transforms
    const strValue = String(value);

    switch (transformType) {
        case 'lowercase':
            return strValue.toLowerCase();

        case 'uppercase':
            return strValue.toUpperCase();

        case 'trim':
            return strValue.trim();

        case 'normalize_phone':
            return normalizePhone(strValue);

        case 'normalize_email':
            return normalizeEmail(strValue);

        default:
            console.warn('Unknown transform type', { transformType });
            return value; // Return original if unknown
    }
}

/**
 * Normalize phone number format
 * Removes all non-digit characters except leading + for international numbers
 *
 * Examples:
 * - "(555) 123-4567" -> "5551234567"
 * - "+1 (555) 123-4567" -> "+15551234567"
 * - "555.123.4567 ext 890" -> "5551234567890"
 */
function normalizePhone(phone: string): string {
    // Keep leading + if present
    const hasPlus = phone.trimStart().startsWith('+');
    const prefix = hasPlus ? '+' : '';

    // Remove all non-digit characters
    const digits = phone.replace(/\D/g, '');

    return prefix + digits;
}

/**
 * Normalize email address
 * Converts to lowercase and trims whitespace
 *
 * Examples:
 * - "  User@Example.COM  " -> "user@example.com"
 * - "ADMIN@COMPANY.COM" -> "admin@company.com"
 */
function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}
