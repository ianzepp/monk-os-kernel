import { withTransaction } from '@src/lib/api-helpers.js';
import { stripSystemFields } from '@src/lib/describe.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * PUT /api/describe/:model/fields
 *
 * Update multiple fields in bulk
 *
 * Request body: Array of field updates
 * Each field must have: field_name (and any fields to update: type, required, default_value, etc.)
 * @returns Array of updated field records from fields table
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model } = params;
    // Validate body is an array
    if (!Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an array of field updates', 'BODY_NOT_ARRAY');
    }

    // Validate each field has field_name
    for (const field of body as any[]) {
        if (!field.field_name) {
            throw HttpErrors.badRequest('Each field update must include field_name', 'FIELD_NAME_REQUIRED');
        }
    }

    // Get model from namespace cache (includes fields with IDs)
    const cachedModel = system.namespace.getModel(model!);

    // Build a map of field_name -> id for quick lookup
    const fieldNameToId = new Map<string, string>();
    for (const [fieldName, field] of cachedModel.fields) {
        fieldNameToId.set(fieldName, field.id);
    }

    // Map field_name to id for each update
    const fieldsToUpdate = body.map((field: any) => {
        const fieldId = fieldNameToId.get(field.field_name);
        if (!fieldId) {
            throw HttpErrors.notFound(
                `Field '${field.field_name}' not found in model '${model}'`,
                'FIELD_NOT_FOUND'
            );
        }

        // Remove field_name from updates (it's not updateable), add id
        const { field_name, ...updates } = field;
        return {
            id: fieldId,
            model_name: model!,
            ...updates
        };
    });

    console.log('PUT /api/describe/:model/fields - Updating fields in bulk:', {
        model: model!,
        fieldCount: fieldsToUpdate.length
    });

    const results = await system.describe.fields.updateAll(fieldsToUpdate);

    // Strip system fields from all results
    return results.map(stripSystemFields);
});
