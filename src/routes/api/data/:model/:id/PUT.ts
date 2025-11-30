import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * PUT /api/data/:model/:id - Update single record by ID
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model, id } = params;
    return await system.database.updateOne(model!, id!, body);
});
