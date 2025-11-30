import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * PUT /api/data/:model/:id/:relationship - Bulk update child records
 *
 * Updates multiple child records belonging to the parent relationship.
 * Body should be an array of child records with IDs.
 *
 * @see docs/routes/DATA_API.md
 * @todo Implement bulk child update functionality
 */
export default withTransaction(async ({ system, params, query, body }) => {
    throw HttpErrors.notImplemented(
        'Bulk relationship update not yet implemented. Use individual child updates via /:child endpoint.',
        'NOT_IMPLEMENTED'
    );
});
