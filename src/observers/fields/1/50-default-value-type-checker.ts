/**
 * Default Value Type Checker - Ring 1 Input Validation
 *
 * Validates that default_value matches the field type.
 * Prevents type mismatches like string defaults for integer fields.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class DefaultValueTypeChecker extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;  // Ring 1
    readonly operations = ['create', 'update'] as const;
    readonly models = ['fields'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { type, default_value } = record;

        // Skip if no default value
        if (default_value === undefined || default_value === null) {
            return;
        }

        if (!type) {
            return; // Type validation handled elsewhere
        }

        // Normalize type (handle both user-facing and PG types)
        const normalizedType = this.normalizeType(type);
        const valueType = typeof default_value;

        // Validate type compatibility
        switch (normalizedType) {
            case 'text':
                if (valueType !== 'string') {
                    throw new ValidationError(
                        `Default value for text field must be a string, got ${valueType}`,
                        'default_value'
                    );
                }
                break;

            case 'integer':
                if (!Number.isInteger(default_value)) {
                    throw new ValidationError(
                        `Default value for integer field must be an integer, got ${valueType}`,
                        'default_value'
                    );
                }
                break;

            case 'numeric':
            case 'decimal':
                if (valueType !== 'number') {
                    throw new ValidationError(
                        `Default value for numeric field must be a number, got ${valueType}`,
                        'default_value'
                    );
                }
                break;

            case 'boolean':
                if (valueType !== 'boolean') {
                    throw new ValidationError(
                        `Default value for boolean field must be a boolean, got ${valueType}`,
                        'default_value'
                    );
                }
                break;

            case 'timestamp':
            case 'date':
                // Accept string (ISO format) or Date object
                if (valueType !== 'string' && !(default_value instanceof Date)) {
                    throw new ValidationError(
                        `Default value for ${normalizedType} field must be a string or Date, got ${valueType}`,
                        'default_value'
                    );
                }
                // Validate ISO format if string
                if (valueType === 'string' && isNaN(Date.parse(default_value))) {
                    throw new ValidationError(
                        `Default value for ${normalizedType} field must be a valid ISO date string`,
                        'default_value'
                    );
                }
                break;

            case 'uuid':
                if (valueType !== 'string') {
                    throw new ValidationError(
                        `Default value for uuid field must be a string, got ${valueType}`,
                        'default_value'
                    );
                }
                // Validate UUID format
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (!uuidRegex.test(default_value)) {
                    throw new ValidationError(
                        'Default value for uuid field must be a valid UUID format',
                        'default_value'
                    );
                }
                break;

            case 'jsonb':
                // JSONB can be object or array
                if (valueType !== 'object') {
                    throw new ValidationError(
                        `Default value for jsonb field must be an object or array, got ${valueType}`,
                        'default_value'
                    );
                }
                break;

            case 'text[]':
                if (!Array.isArray(default_value)) {
                    throw new ValidationError(
                        'Default value for text[] field must be an array',
                        'default_value'
                    );
                }
                if (!default_value.every((v: any) => typeof v === 'string')) {
                    throw new ValidationError(
                        'Default value for text[] field must be an array of strings',
                        'default_value'
                    );
                }
                break;

            case 'integer[]':
                if (!Array.isArray(default_value)) {
                    throw new ValidationError(
                        'Default value for integer[] field must be an array',
                        'default_value'
                    );
                }
                if (!default_value.every((v: any) => Number.isInteger(v))) {
                    throw new ValidationError(
                        'Default value for integer[] field must be an array of integers',
                        'default_value'
                    );
                }
                break;

            case 'numeric[]':
            case 'decimal[]':
                if (!Array.isArray(default_value)) {
                    throw new ValidationError(
                        'Default value for numeric[] field must be an array',
                        'default_value'
                    );
                }
                if (!default_value.every((v: any) => typeof v === 'number')) {
                    throw new ValidationError(
                        'Default value for numeric[] field must be an array of numbers',
                        'default_value'
                    );
                }
                break;

            case 'uuid[]':
                if (!Array.isArray(default_value)) {
                    throw new ValidationError(
                        'Default value for uuid[] field must be an array',
                        'default_value'
                    );
                }
                const uuidArrayRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (!default_value.every((v: any) => typeof v === 'string' && uuidArrayRegex.test(v))) {
                    throw new ValidationError(
                        'Default value for uuid[] field must be an array of valid UUIDs',
                        'default_value'
                    );
                }
                break;
        }
    }

    private normalizeType(type: string): string {
        // Handle both user-facing types (decimal) and PG types (numeric)
        const typeMap: Record<string, string> = {
            'decimal': 'numeric',
            'decimal[]': 'numeric[]'
        };
        return typeMap[type] || type;
    }
}
