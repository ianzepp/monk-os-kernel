import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * GET /api/user/:id - Get user profile
 *
 * Returns user profile for the specified user.
 * The :id parameter can be a UUID or "me" for the current user.
 *
 * Permissions:
 * - "me" or own user ID: Any authenticated user
 * - Other user IDs: Requires sudo access
 */
export default withTransaction(async ({ system, params }) => {
    const targetId = params.id === 'me' ? system.userId : params.id;
    const isSelf = targetId === system.userId;

    // Non-self access requires sudo
    if (!isSelf && !system.isSudo()) {
        throw HttpErrors.forbidden(
            'Viewing other users requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const user = await system.database.select404(
        'users',
        { where: { id: targetId } },
        'User not found'
    );

    return user;
});
