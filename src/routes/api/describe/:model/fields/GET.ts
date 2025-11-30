import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
/**
 * GET /api/describe/:model/fields - List all fields for a model
 *
 * Returns array of all field definitions for the specified model.
 */
export default withTransaction(async ({ system, params }) => {
    const { model } = params;
    const modelRecord = await system.describe.models.selectOne({ model: model });

    if (!modelRecord) {
        throw HttpErrors.notFound(`Model '${model}' not found`, 'MODEL_NOT_FOUND');
    }

    // Query fields table for all fields in this model
    const fields = await system.describe.fields.selectAny({
        where: { model_name: model },
        order: { field_name: 'asc' }
    });

    return fields;
});
