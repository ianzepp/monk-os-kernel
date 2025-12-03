/**
 * Constraints Observer - Ring 1 Validation
 *
 * TODO: Revisit for performance review. This observer does the most work in
 * Ring 1 (type checking, regex matching, JSON parsing for enums). Consider:
 * - Caching compiled RegExp objects per field
 * - Caching parsed enum arrays per field
 * - Early exit optimizations for common cases
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Constraints is a Ring 1 observer (priority 40) that validates field data
 * against schema constraints defined in field metadata.
 *
 * Validations performed:
 * - Required: Field must have a non-null value on create
 * - Type: Value must match field type (text, integer, numeric, boolean, etc.)
 * - Array: If is_array, value must be an array with elements of correct type
 * - Minimum/Maximum: Numeric values must be within range
 * - Pattern: String values must match regex pattern
 * - Enum: Value must be one of the allowed enum values
 *
 * EXECUTION FLOW
 * ==============
 * ```
 * Ring 1 (Frozen, Immutable passed)
 *     │
 * Ring 1 (this): ──► For each validation field:
 *     │                  Check required
 *     │                  Check type
 *     │                  Check min/max
 *     │                  Check pattern
 *     │                  Check enum
 *     │                      │
 *     │                      Collect errors
 *     ▼                      │
 * After loop: any errors? ──► YES ──► throw EOBSINVALID
 *     │
 *     NO
 *     ▼
 * Ring 2+: Continue pipeline
 * ```
 *
 * INVARIANTS
 * ==========
 * INV-1: On update, only validate fields being changed
 * INV-2: Null/undefined values skip type/constraint checks (unless required)
 * INV-3: Error includes field name and validation details
 *
 * @module model/ring/1/constraints
 */

import { BaseObserver } from '../../observers/base-observer.js';
import type { ObserverContext, FieldRow } from '../../observers/interfaces.js';
import { ObserverRing, type OperationType } from '../../observers/types.js';
import { EOBSINVALID } from '../../observers/errors.js';

// =============================================================================
// TYPES
// =============================================================================

interface ValidationError {
    field: string;
    message: string;
    code: string;
}

// =============================================================================
// CONSTRAINTS OBSERVER
// =============================================================================

/**
 * Validates field data against schema constraints.
 *
 * WHY priority 40: After Frozen (10) and Immutable (30). This is the most
 * expensive Ring 1 validation, so run it last.
 */
export class Constraints extends BaseObserver {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    readonly name = 'Constraints';

    /**
     * Ring 1 = Input validation.
     */
    readonly ring = ObserverRing.InputValidation;

    /**
     * Priority 40 = late in validation ring.
     */
    readonly priority = 40;

    /**
     * Validates on create and update.
     */
    readonly operations: readonly OperationType[] = ['create', 'update'];

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Validate field constraints.
     *
     * ALGORITHM:
     * 1. Get fields that need validation from model
     * 2. For each field:
     *    a. On update, skip if field not being changed
     *    b. Check required constraint
     *    c. If value is null/undefined, skip other checks
     *    d. Check type constraint
     *    e. Check min/max constraints
     *    f. Check pattern constraint
     *    g. Check enum constraint
     * 3. If any errors, throw EOBSINVALID with summary
     *
     * @param context - Observer context with model and record
     * @throws EOBSINVALID if any constraint is violated
     */
    async execute(context: ObserverContext): Promise<void> {
        const { model, record, operation } = context;

        const validationFields = model.getValidationFields();
        if (validationFields.length === 0) return;

        const errors: ValidationError[] = [];

        for (const field of validationFields) {
            // On update, only validate fields being changed
            if (operation === 'update' && !record.has(field.field_name)) {
                continue;
            }

            const value = record.get(field.field_name);
            this.validateField(field, value, operation, errors);
        }

        if (errors.length > 0) {
            const summary = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
            throw new EOBSINVALID(`Validation failed: ${summary}`, errors[0].field);
        }
    }

    // =========================================================================
    // FIELD VALIDATION
    // =========================================================================

    /**
     * Validate a single field against its constraints.
     */
    private validateField(
        field: FieldRow,
        value: unknown,
        operation: string,
        errors: ValidationError[]
    ): void {
        // Required check
        if (field.required && (value === null || value === undefined)) {
            if (operation === 'create') {
                errors.push({
                    field: field.field_name,
                    message: 'is required',
                    code: 'REQUIRED',
                });
            }
            return; // Skip other validations if null
        }

        // Skip further validation for null/undefined values
        if (value === null || value === undefined) return;

        // Type check
        const typeError = this.validateType(value, field.type, field.is_array);
        if (typeError) {
            errors.push({
                field: field.field_name,
                message: typeError,
                code: 'INVALID_TYPE',
            });
            return; // Skip constraint checks if wrong type
        }

        // Minimum/maximum for numbers
        if (field.minimum !== null && field.minimum !== undefined && typeof value === 'number') {
            if (value < field.minimum) {
                errors.push({
                    field: field.field_name,
                    message: `must be >= ${field.minimum}`,
                    code: 'BELOW_MINIMUM',
                });
            }
        }
        if (field.maximum !== null && field.maximum !== undefined && typeof value === 'number') {
            if (value > field.maximum) {
                errors.push({
                    field: field.field_name,
                    message: `must be <= ${field.maximum}`,
                    code: 'ABOVE_MAXIMUM',
                });
            }
        }

        // Pattern for strings
        if (field.pattern && typeof value === 'string') {
            const regex = new RegExp(field.pattern);
            if (!regex.test(value)) {
                errors.push({
                    field: field.field_name,
                    message: `does not match pattern ${field.pattern}`,
                    code: 'PATTERN_MISMATCH',
                });
            }
        }

        // Enum values
        if (field.enum_values) {
            const allowed = JSON.parse(field.enum_values) as string[];
            if (!allowed.includes(String(value))) {
                errors.push({
                    field: field.field_name,
                    message: `must be one of: ${allowed.join(', ')}`,
                    code: 'INVALID_ENUM',
                });
            }
        }
    }

    // =========================================================================
    // TYPE VALIDATION
    // =========================================================================

    /**
     * Validate value type against field type.
     *
     * @returns Error message if invalid, null if valid
     */
    private validateType(value: unknown, type: string, isArray: boolean): string | null {
        if (isArray) {
            if (!Array.isArray(value)) {
                return `expected array, got ${typeof value}`;
            }
            // Validate array elements
            for (const item of value) {
                const itemError = this.validateScalarType(item, type);
                if (itemError) return `array element ${itemError}`;
            }
            return null;
        }

        return this.validateScalarType(value, type);
    }

    /**
     * Validate a scalar (non-array) value against a type.
     *
     * @returns Error message if invalid, null if valid
     */
    private validateScalarType(value: unknown, type: string): string | null {
        switch (type) {
            case 'text':
            case 'uuid':
            case 'timestamp':
            case 'date':
                if (typeof value !== 'string') {
                    return `expected string, got ${typeof value}`;
                }
                break;

            case 'integer':
                if (typeof value !== 'number' || !Number.isInteger(value)) {
                    return `expected integer, got ${typeof value}${typeof value === 'number' ? ' (decimal)' : ''}`;
                }
                break;

            case 'numeric':
                if (typeof value !== 'number') {
                    return `expected number, got ${typeof value}`;
                }
                break;

            case 'boolean':
                if (typeof value !== 'boolean') {
                    return `expected boolean, got ${typeof value}`;
                }
                break;

            case 'jsonb':
                // Any value is valid for JSON
                break;
        }

        return null;
    }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default Constraints;
