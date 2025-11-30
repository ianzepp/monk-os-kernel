import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/trashed/:model/:id - Get a specific trashed record
 *
 * Returns the trashed record if found, or 404 if not found or not trashed.
 */
export default withTransaction(async ({ system, params }) => {
    const { model, id } = params;

    // Select with trashed='only' to find only trashed records
    const record = await system.database.select404(model, { where: { id } }, 'Record not found or not trashed', {
        trashed: 'only',
    });

    return record;
});
