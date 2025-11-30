import { withTransaction } from '@src/lib/api-helpers.js';
import { stripSystemFields } from '@src/lib/describe.js';

/**
 * GET /api/describe/:model - Get model metadata
 *
 * Returns model record only (without fields).
 * Use GET /api/describe/:model/fields/:field for individual field definitions.
 */
export default withTransaction(async ({ system, params }) => {
    const { model } = params;
    const result = await system.describe.models.select404(
        { where: { model_name: model } },
        `Model '${model}' not found`
    );

    // Strip system fields before returning
    return stripSystemFields(result);
});
