import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * DELETE /api/data/:model - Bulk soft delete records in model
 *
 * Sets trashed_at on records. To permanently delete, use DELETE /api/trashed/:model.
 *
 * @see docs/routes/DATA_API.md
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model } = params;

    if (!Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an array of records', 'BODY_NOT_ARRAY');
    }

    return await system.database.deleteAll(model, body);
});
