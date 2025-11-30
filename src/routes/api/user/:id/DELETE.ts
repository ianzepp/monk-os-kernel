import { withTransaction, withSelfServiceSudo } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * DELETE /api/user/:id - Delete/deactivate user
 *
 * Deletes (soft delete) the specified user.
 * The :id parameter can be a UUID or "me" for the current user.
 *
 * Permissions:
 * - "me" or own user ID: Self-deactivation, requires confirm=true in body
 * - Other user IDs: Requires sudo access
 *
 * Self-deactivation request body:
 * {
 *   "confirm": true,           // Required for self-deactivation
 *   "reason": "Leaving team"   // Optional: Reason for audit log
 * }
 */
export default withTransaction(async ({ system, params, body }) => {
    const targetId = params.id === 'me' ? system.userId : params.id;
    const isSelf = targetId === system.userId;
    const hasSudo = system.isSudo();

    // Non-self access requires sudo
    if (!isSelf && !hasSudo) {
        throw HttpErrors.forbidden(
            'Deleting other users requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    // Self-deactivation requires explicit confirmation
    if (isSelf && !hasSudo) {
        if (body?.confirm !== true) {
            throw HttpErrors.badRequest(
                'Account deactivation requires explicit confirmation',
                'CONFIRMATION_REQUIRED',
                { field: 'confirm', required_value: true }
            );
        }

        const deactivatedAt = new Date().toISOString();
        await withSelfServiceSudo(system, async () => {
            await system.database.updateOne('users', targetId, {
                trashed_at: deactivatedAt,
                updated_at: deactivatedAt
            });
        });

        return {
            message: 'Account deactivated successfully',
            deactivated_at: deactivatedAt,
            reason: body?.reason || null
        };
    }

    // Admin deletion
    await system.database.deleteOne('users', targetId);
    return { message: 'User deleted successfully' };
});
