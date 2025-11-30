import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * DELETE /api/trashed/:model - Permanently delete multiple trashed records
 *
 * Body should be an array of record IDs to permanently delete:
 * ["id1", "id2", "id3"]
 *
 * Returns the permanently deleted records.
 * This action is irreversible - records will have deleted_at set.
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

    // Convert to expire input format
    const expires = body.map(id => ({ id }));

    // Permanently delete all records (sets deleted_at via observer pipeline)
    return await system.database.expireAll(model, expires);
});
