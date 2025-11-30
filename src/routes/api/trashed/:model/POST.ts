import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * POST /api/trashed/:model - Restore multiple trashed records
 *
 * Body should be an array of record IDs to restore:
 * ["id1", "id2", "id3"]
 *
 * Returns the restored records.
 */
export default withTransaction(async ({ system, params, body }) => {
    const { model } = params;

    // Validate body is an array of IDs
    if (!Array.isArray(body)) {
        throw HttpErrors.badRequest('Request body must be an array of record IDs', 'BODY_NOT_ARRAY');
    }

    if (body.length === 0) {
        return [];
    }

    // Validate all elements are strings (IDs)
    for (const id of body) {
        if (typeof id !== 'string') {
            throw HttpErrors.badRequest('All elements in the array must be string IDs', 'INVALID_ID_FORMAT');
        }
    }

    // Convert to revert input format
    const reverts = body.map(id => ({ id, trashed_at: null as null }));

    // Revert all records
    const result = await system.database.revertAll(model, reverts);

    return result;
});
