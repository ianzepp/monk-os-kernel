import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/trashed - List all trashed records across all models
 *
 * Returns a summary object with model names as keys and arrays of trashed records as values.
 * Only includes models that have at least one trashed record.
 */
export default withTransaction(async ({ system }) => {
    // Get all model names
    const models = await system.describe.models.selectAny({ order: { model_name: 'asc' } });
    const modelNames = models.map((model: any) => model.model_name);

    const result: Record<string, any[]> = {};

    // Query each model for trashed records
    for (const modelName of modelNames) {
        const trashedRecords = await system.database.selectAny(modelName, {}, {
            trashed: 'only',
        });

        if (trashedRecords.length > 0) {
            result[modelName] = trashedRecords;
        }
    }

    return result;
});
