import { withTransaction } from '@src/lib/api-helpers.js';
import { stripSystemFields } from '@src/lib/describe.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

export default withTransaction(async ({ system, params, query, body }) => {
    const { model } = params;
    // Model name comes from URL parameter
    // Body contains model metadata only (status, sudo, frozen)
    // Use field endpoints for field management
    const modelName = model!.toLowerCase();

    // Validate model name mismatch (URL vs body)
    if (body.model_name && body.model_name.toLowerCase() !== modelName) {
        const force = query.force === 'true';
        if (!force) {
            throw HttpErrors.badRequest(
                `Model name mismatch: URL has '${modelName}' but body has '${body.model_name}'. Use ?force=true to override.`
            );
        }
        // If force=true, use body's model_name (will be spread below)
    }

    // Extract inline fields if provided (supports both object and array format)
    const { fields: inlineFields, ...modelData } = body;

    // Create model record via wrapper
    const dataToCreate = {
        model_name: modelName,
        ...modelData
    };

    const result = await system.describe.models.createOne(dataToCreate);

    // If inline fields were provided, create them
    let createdFields: any[] = [];
    if (inlineFields) {
        // Normalize fields to array format
        // Supports: { fieldName: {type, ...} } or [{ field_name, type, ...}]
        const fieldsArray = Array.isArray(inlineFields)
            ? inlineFields
            : Object.entries(inlineFields).map(([fieldName, fieldDef]) => ({
                  field_name: fieldName,
                  ...(fieldDef as object)
              }));

        // Add model_name to each field
        const fieldsToCreate = fieldsArray.map((field) => ({
            ...field,
            model_name: modelName
        }));

        if (fieldsToCreate.length > 0) {
            createdFields = await system.describe.fields.createAll(fieldsToCreate);
        }
    }

    // Return model with fields if any were created
    const response = stripSystemFields(result);
    if (createdFields.length > 0) {
        response.fields = createdFields.map(stripSystemFields);
    }

    return response;
});
