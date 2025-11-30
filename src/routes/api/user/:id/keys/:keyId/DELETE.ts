import { withTransaction, withSelfServiceSudo } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

// TODO: SECURITY - The 'credentials' model is currently visible via /api/data/credentials
// This exposes password hashes and API key hashes to users with read access.
// Options to fix:
// 1. Add 'internal' flag to models table, check in database select/pipeline
// 2. Remove credentials from model seed data, rewrite routes to use raw SQL

/**
 * DELETE /api/user/:id/keys/:keyId - Delete an API key
 *
 * Permanently deletes an API key. This action cannot be undone.
 *
 * Permissions:
 * - "me" or own user ID: Can delete own keys
 * - Other user IDs: Requires sudo access
 */
export default withTransaction(async ({ system, params }) => {
    const targetId = params.id === 'me' ? system.userId : params.id;
    const keyId = params.keyId;
    const isSelf = targetId === system.userId;
    const hasSudo = system.isSudo();

    // Non-self access requires sudo
    if (!isSelf && !hasSudo) {
        throw HttpErrors.forbidden(
            'Deleting API keys for other users requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    // Verify target user exists
    const user = await system.database.selectOne('users', {
        where: { id: targetId }
    });

    if (!user) {
        throw HttpErrors.notFound('User not found', 'USER_NOT_FOUND');
    }

    // Find the API key
    const key = await system.database.selectOne('credentials', {
        where: {
            id: keyId,
            user_id: targetId,
            type: 'api_key',
        }
    });

    if (!key) {
        throw HttpErrors.notFound('API key not found', 'KEY_NOT_FOUND');
    }

    // Hard delete the key (not soft delete - keys should be fully removed)
    await withSelfServiceSudo(system, async () => {
        await system.database.deleteOne('credentials', keyId);
    });

    return {
        success: true,
        message: 'API key deleted',
    };
});
