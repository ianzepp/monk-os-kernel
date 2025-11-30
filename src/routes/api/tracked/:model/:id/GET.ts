import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/tracked/:model/:id - List all tracked changes for a record
 *
 * Returns all tracked entries for the specified record, ordered by change_id DESC.
 * Supports pagination via ?limit and ?offset query parameters.
 */
export default withTransaction(async ({ system, params, query, body }) => {
    const { model, id } = params;

    // Query tracked table for this model+record combination
    const result = await system.database.selectAny(
        'tracked',
        {
            where: {
                model_name: model,
                record_id: id
            },
            order: { change_id: 'desc' }
        }
    );

    return result;
});
