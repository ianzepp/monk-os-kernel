import { withTransaction } from '@src/lib/api-helpers.js';
import { stripSystemFields } from '@src/lib/describe.js';

/**
 * DELETE /api/describe/:model/fields/:field
 *
 * Delete a field from the model
 *
 * @returns Deletion confirmation
 */
export default withTransaction(async ({ system, params }) => {
    const { model, field } = params;
    const result = await system.describe.fields.delete404(
        { where: { model_name: model, field_name: field } },
        `Field '${field}' not found in model '${model}'`
    );

    // Strip system fields before returning
    return stripSystemFields(result);
});
