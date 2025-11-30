import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * GET /api/trashed/:model - List all trashed records for a specific model
 *
 * Returns an array of all trashed records for the specified model.
 */
export default withTransaction(async ({ system, params }) => {
    const { model } = params;

    const trashedRecords = await system.database.selectAny(model, {}, {
        trashed: 'only',
    });

    return trashedRecords;
});
