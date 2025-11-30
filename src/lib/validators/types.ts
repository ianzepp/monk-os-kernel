/**
 * Type Validator
 *
 * Validates that field values match their declared types.
 * Supports: text, integer, bigserial, numeric, boolean, jsonb, uuid,
 * timestamp, date, and array variants.
 */

import type { ValidationError } from './required.js';

// UUID regex pattern - validates format only (8-4-4-4-12 hex format)
// Accepts any valid UUID format including nil UUID, test UUIDs, and all variants
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO 8601 date pattern (YYYY-MM-DD)
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate that field values match their declared types
 *
 * @param record - The record being validated
 * @param recordIndex - Index of the record in the batch (for error reporting)
 * @param typedFields - Map of field names to their type info
 * @returns Array of validation errors (empty if valid)
 */
export function validateTypes(
    record: Record<string, any>,
    recordIndex: number,
    typedFields: Map<string, { type: string; is_array: boolean }>
): ValidationError[] {
    const errors: ValidationError[] = [];

    // Early exit if no typed fields
    if (typedFields.size === 0) {
        return errors;
    }

    // Iterate only over fields present in the record
    for (const [fieldName, value] of Object.entries(record)) {
        // Skip if field has no type definition
        const typeInfo = typedFields.get(fieldName);
        if (!typeInfo) {
            continue;
        }

        // Allow null/undefined for non-required fields (required validator handles this)
        if (value === null || value === undefined) {
            continue;
        }

        // Validate based on type
        const error = validateType(value, typeInfo.type, typeInfo.is_array);
        if (error) {
            errors.push({
                record: recordIndex,
                field: fieldName,
                message: `Field '${fieldName}' ${error}`,
                code: 'INVALID_TYPE',
            });
        }
    }

    return errors;
}

/**
 * Validate array type - exported for use by DataValidator
 * @returns Error message if invalid, null if valid
 */
export function validateArrayType(value: any, type: string): string | null {
    if (!Array.isArray(value)) {
        return `expected array but got ${typeof value}`;
    }

    // Get element type (remove [] suffix if present)
    const elementType = type.replace('[]', '');

    // Validate each array element
    for (let i = 0; i < value.length; i++) {
        const element = value[i];
        const error = validateScalarType(element, elementType);
        if (error) {
            return `array element [${i}] ${error}`;
        }
    }

    return null;
}

/**
 * Validate a single value against its expected type
 * @returns Error message if invalid, null if valid
 */
function validateType(value: any, type: string, isArray: boolean): string | null {
    // Handle array types
    if (isArray || type.endsWith('[]')) {
        if (!Array.isArray(value)) {
            return `expected array but got ${typeof value}`;
        }

        // Get element type (remove [] suffix if present)
        const elementType = type.replace('[]', '');

        // Validate each array element
        for (let i = 0; i < value.length; i++) {
            const element = value[i];
            const error = validateScalarType(element, elementType);
            if (error) {
                return `array element [${i}] ${error}`;
            }
        }

        return null;
    }

    // Handle scalar types
    return validateScalarType(value, type);
}

/**
 * Validate a scalar (non-array) value - exported for use by DataValidator
 * @returns Error message if invalid, null if valid
 */
export function validateScalarType(value: any, type: string): string | null {
    switch (type) {
        case 'text':
            if (typeof value !== 'string') {
                return `expected string but got ${typeof value}`;
            }
            return null;

        case 'integer':
        case 'bigserial':
            if (!Number.isInteger(value)) {
                return `expected integer but got ${typeof value}`;
            }
            // Optional: Check 32-bit integer range for 'integer' type
            if (type === 'integer' && (value < -2147483648 || value > 2147483647)) {
                return `integer value ${value} out of range (-2147483648 to 2147483647)`;
            }
            return null;

        case 'numeric':
            if (typeof value !== 'number' || isNaN(value)) {
                return `expected number but got ${typeof value}`;
            }
            if (!isFinite(value)) {
                return `expected finite number but got ${value}`;
            }
            return null;

        case 'boolean':
            if (typeof value !== 'boolean') {
                return `expected boolean but got ${typeof value}`;
            }
            return null;

        case 'jsonb':
            // JSONB must be an object or array (not primitive)
            if (typeof value !== 'object' || value === null) {
                return `expected object or array but got ${typeof value}`;
            }
            return null;

        case 'uuid':
            if (typeof value !== 'string') {
                return `expected UUID string but got ${typeof value}`;
            }
            if (!UUID_PATTERN.test(value)) {
                return `expected valid UUID format but got '${value}'`;
            }
            return null;

        case 'timestamp':
            // Accept Date objects or ISO 8601 strings
            if (value instanceof Date) {
                if (isNaN(value.getTime())) {
                    return `expected valid Date but got invalid Date`;
                }
                return null;
            }
            if (typeof value === 'string') {
                const parsed = Date.parse(value);
                if (isNaN(parsed)) {
                    return `expected valid ISO 8601 timestamp but got '${value}'`;
                }
                return null;
            }
            return `expected Date or ISO 8601 string but got ${typeof value}`;

        case 'date':
            // Accept Date objects or YYYY-MM-DD strings
            if (value instanceof Date) {
                if (isNaN(value.getTime())) {
                    return `expected valid Date but got invalid Date`;
                }
                return null;
            }
            if (typeof value === 'string') {
                if (!DATE_PATTERN.test(value)) {
                    return `expected YYYY-MM-DD format but got '${value}'`;
                }
                // Validate it parses to a valid date
                const parsed = Date.parse(value);
                if (isNaN(parsed)) {
                    return `expected valid date but got '${value}'`;
                }
                return null;
            }
            return `expected Date or YYYY-MM-DD string but got ${typeof value}`;

        default:
            // Unknown type - allow it (database will validate)
            return null;
    }
}
