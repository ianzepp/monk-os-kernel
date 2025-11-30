/**
 * Required Field Validator
 *
 * Validates that all required fields are present and non-null.
 * Returns array of validation errors for missing required fields.
 */

export interface ValidationError {
    record: number;
    field: string;
    message: string;
    code: string;
}

/**
 * Validate that all required fields are present and have non-null values
 *
 * @param record - The record being validated
 * @param recordIndex - Index of the record in the batch (for error reporting)
 * @param requiredFields - Set of field names that are required
 * @returns Array of validation errors (empty if valid)
 */
export function validateRequired(
    record: Record<string, any>,
    recordIndex: number,
    requiredFields: Set<string>
): ValidationError[] {
    const errors: ValidationError[] = [];

    // Early exit if no required fields
    if (requiredFields.size === 0) {
        return errors;
    }

    // Check each required field
    for (const fieldName of requiredFields) {
        const value = record[fieldName];

        // Field is missing or explicitly null/undefined
        if (value === null || value === undefined) {
            errors.push({
                record: recordIndex,
                field: fieldName,
                message: `Field '${fieldName}' is required but missing or null`,
                code: 'REQUIRED_FIELD_MISSING',
            });
        }
        // Empty string check (optional - uncomment if empty strings should fail)
        // else if (typeof value === 'string' && value.trim() === '') {
        //     errors.push({
        //         record: recordIndex,
        //         field: fieldName,
        //         message: `Field '${fieldName}' is required but empty`,
        //         code: 'REQUIRED_FIELD_EMPTY',
        //     });
        // }
    }

    return errors;
}
