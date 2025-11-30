import { withTransaction } from '@src/lib/api-helpers.js';
import { isSystemField, stripSystemFields } from '@src/lib/describe.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * GET /api/describe/:model/fields/:field
 *
 * Retrieve field definition in Monk-native format
 *
 * @returns Field record from fields table
 */
export default withTransaction(async ({ system, params }) => {
    const { model, field } = params;
    // Reject requests for system fields - Describe API is for portable definitions only
    if (isSystemField(field!)) {
        throw HttpErrors.notFound(
            `Field '${field}' is a system field and not available via Describe API`,
            'SYSTEM_FIELD_NOT_ACCESSIBLE'
        );
    }

    const fieldDef = await system.describe.fields.select404(
        { where: { model_name: model, field_name: field } },
        `Field '${field}' not found in model '${model}'`
    );
    // Strip system fields before returning
    return stripSystemFields(fieldDef);
});
