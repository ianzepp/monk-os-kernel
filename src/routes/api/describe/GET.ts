import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/describe - List all model names
 * @see docs/31-describe-api.md
 */
export default withTransaction(async ({ system }) => {
    const models = await system.describe.models.selectAny({ order: { model_name: 'asc' } });
    // Extract just the model names from the full model objects
    const modelNames = models.map((model: any) => model.model_name);
    return modelNames;
});
