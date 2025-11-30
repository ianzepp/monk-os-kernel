import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';

// TODO: SECURITY - The 'credentials' model is currently visible via /api/data/credentials
// This exposes password hashes and API key hashes to users with read access.
// Options to fix:
// 1. Add 'internal' flag to models table, check in database select/pipeline
// 2. Remove credentials from model seed data, rewrite routes to use raw SQL

/**
 * GET /api/user/:id/keys - List API keys for a user
 *
 * Returns all API keys for the specified user. The actual key values
 * are never returned - only metadata (prefix, name, permissions, etc.).
 *
 * Permissions:
 * - "me" or own user ID: Can list own keys
 * - Other user IDs: Requires sudo access
 */
export default withTransaction(async ({ system, params }) => {
    const targetId = params.id === 'me' ? system.userId : params.id;
    const isSelf = targetId === system.userId;
    const hasSudo = system.isSudo();

    // Non-self access requires sudo
    if (!isSelf && !hasSudo) {
        throw HttpErrors.forbidden(
            'Listing API keys for other users requires sudo access',
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

    // Get all API keys for this user (never return the secret/hash)
    const keys = await system.database.selectAny('credentials', {
        where: {
            user_id: targetId,
            type: 'api_key',
        },
        order: { created_at: 'desc' }
    });

    // Return only safe fields (never the secret hash)
    return keys.map((key: any) => ({
        id: key.id,
        name: key.name,
        prefix: key.identifier,
        permissions: key.permissions ? JSON.parse(key.permissions) : null,
        expires_at: key.expires_at,
        last_used_at: key.last_used_at,
        created_at: key.created_at,
    }));
});
