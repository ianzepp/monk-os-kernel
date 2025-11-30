import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * POST /api/trashed/:model/:id - Restore a specific trashed record
 *
 * Restores the record by setting trashed_at to null.
 * Returns the restored record, or 404 if not found or not trashed.
 */
export default withTransaction(async ({ system, params }) => {
    const { model, id } = params;

    // Revert the single record
    const result = await system.database.revertOne(model, id);

    return result;
});
