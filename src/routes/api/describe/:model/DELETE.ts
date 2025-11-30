import { withTransaction } from '@src/lib/api-helpers.js';
import { stripSystemFields } from '@src/lib/describe.js';

/**
 * DELETE /api/describe/:model - Delete model
 *
 * Soft deletes model and drops table via observer pipeline.
 */
export default withTransaction(async ({ system, params }) => {
    const { model } = params;
    const result = await system.describe.models.delete404(
        { where: { model_name: model } },
        `Model '${model}' not found`
    );

    // Strip system fields before returning
    return stripSystemFields(result);
});
