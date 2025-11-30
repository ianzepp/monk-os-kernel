import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/tracked/:model/:id/:change - Get specific tracked change
 *
 * Returns a single tracked entry by change_id for the specified record.
 * Returns 404 if the change_id doesn't exist for this model+record combination.
 */
export default withTransaction(async ({ system, params, query, body }) => {
    const { model, id, change } = params;

    // Query tracked table for specific change
    const result = await system.database.select404(
        'tracked',
        {
            where: {
                change_id: change,
                model_name: model,
                record_id: id
            }
        }
    );

    return result;
});
