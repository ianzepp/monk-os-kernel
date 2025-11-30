import { withTransaction } from '@src/lib/api-helpers.js';

/**
 * DELETE /api/data/:model/:id - Soft delete single record by ID
 *
 * Sets trashed_at on the record. To permanently delete, use DELETE /api/trashed/:model/:id.
 *
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params }) => {
    const { model, id } = params;
    return await system.database.delete404(model, { where: { id } });
});
