import { withTransaction } from '@src/lib/api-helpers.js';
import { stripSystemFields } from '@src/lib/describe.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * POST /api/describe/:model/fields
 *
 * Create multiple fields in bulk
 *
 * Request body: Array of field definitions
 * Each field must have: field_name, type (and optional: required, default_value, etc.)
 * @returns Array of created field records from fields table
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model } = params;
    // Validate body is an array
    if (!Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an array of field definitions');
    }

    // Validate each field has field_name
    for (const field of body) {
        if (!field.field_name) {
            throw HttpErrors.badRequest('Each field definition must include field_name');
        }
    }

    // Inject model_name into each field definition
    const fieldsToCreate = body.map(field => ({
        model_name: model!,
        ...field
    }));

    console.log('POST /api/describe/:model/fields - Creating fields in bulk:', {
        model: model!,
        fieldCount: fieldsToCreate.length
    });

    const results = await system.describe.fields.createAll(fieldsToCreate);

    // Strip system fields from all results
    return results.map(stripSystemFields);
});
