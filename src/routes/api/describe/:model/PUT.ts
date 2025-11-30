import { withTransaction } from '@src/lib/api-helpers.js';
import { stripSystemFields } from '@src/lib/describe.js';

/**
 * PUT /api/describe/:model - Update model metadata
 *
 * Updates model properties like status, sudo, frozen.
 * Does not modify fields - use field endpoints for that.
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model } = params;
    const result = await system.describe.models.update404(
        { where: { model_name: model } },
        body,
        `Model '${model}' not found`
    );
    // Strip system fields before returning
    return stripSystemFields(result);
});
