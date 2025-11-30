import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * GET /api/user - List all users in tenant
 *
 * Returns all users within the authenticated user's tenant.
 * Requires sudo access.
 *
 * Query parameters:
 * - limit: Maximum number of records (default: 100)
 * - offset: Number of records to skip (default: 0)
 */
export default withTransaction(async ({ system, query }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Listing users requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const limit = Math.min(parseInt(query.limit) || 100, 1000);
    const offset = parseInt(query.offset) || 0;

    const users = await system.database.selectAny('users', {
        order: [{ field: 'created_at', direction: 'DESC' }],
        limit,
        offset,
    });

    return users;
});
