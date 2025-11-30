import { withTransaction, withSelfServiceSudo } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { generateApiKey, type ApiKeyEnvironment } from '@src/lib/credentials/index.js';
import { randomUUID } from 'crypto';

// TODO: SECURITY - The 'credentials' model is currently visible via /api/data/credentials
// This exposes password hashes and API key hashes to users with read access.
// Options to fix:
// 1. Add 'internal' flag to models table, check in database select/pipeline
// 2. Remove credentials from model seed data, rewrite routes to use raw SQL

/**
 * POST /api/user/:id/keys - Create a new API key
 *
 * Creates a new API key for the specified user. The full key is returned
 * ONLY in this response - it cannot be retrieved later.
 *
 * Body:
 * - name: Optional friendly name for the key
 * - environment: Optional, one of 'live', 'test', 'dev' (default: 'live')
 * - permissions: Optional JSON object with permission settings
 * - expires_at: Optional expiration timestamp (ISO 8601)
 *
 * Permissions:
 * - "me" or own user ID: Can create own keys
 * - Other user IDs: Requires sudo access
 */
export default withTransaction(async ({ system, params, body }) => {
    const targetId = params.id === 'me' ? system.userId : params.id;
    const isSelf = targetId === system.userId;
    const hasSudo = system.isSudo();

    // Non-self access requires sudo
    if (!isSelf && !hasSudo) {
        throw HttpErrors.forbidden(
            'Creating API keys for other users requires sudo access',
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

    // Validate environment if provided
    const environment = body.environment || 'live';
    if (!['live', 'test', 'dev'].includes(environment)) {
        throw HttpErrors.badRequest(
            'Invalid environment. Must be one of: live, test, dev',
            'VALIDATION_ERROR',
            { field: 'environment' }
        );
    }

    // Validate expires_at if provided
    let expiresAt: string | null = null;
    if (body.expires_at) {
        const date = new Date(body.expires_at);
        if (isNaN(date.getTime())) {
            throw HttpErrors.badRequest(
                'Invalid expires_at format. Use ISO 8601 format.',
                'VALIDATION_ERROR',
                { field: 'expires_at' }
            );
        }
        if (date <= new Date()) {
            throw HttpErrors.badRequest(
                'expires_at must be in the future',
                'VALIDATION_ERROR',
                { field: 'expires_at' }
            );
        }
        expiresAt = date.toISOString();
    }

    // Generate the API key
    const generated = generateApiKey(environment as ApiKeyEnvironment);

    // Create credential record
    const credential = {
        id: randomUUID(),
        user_id: targetId,
        type: 'api_key',
        identifier: generated.prefix,
        secret: generated.hash,
        algorithm: generated.algorithm,
        permissions: body.permissions ? JSON.stringify(body.permissions) : null,
        name: body.name || null,
        expires_at: expiresAt,
        last_used_at: null,
    };

    // Use self-service sudo for creating credential
    await withSelfServiceSudo(system, async () => {
        await system.database.createOne('credentials', credential);
    });

    // Return the full key ONLY in this response
    return {
        success: true,
        message: 'API key created. Save this key - it will not be shown again.',
        data: {
            id: credential.id,
            key: generated.key, // Full key - only shown once!
            prefix: generated.prefix,
            name: credential.name,
            permissions: body.permissions || null,
            expires_at: expiresAt,
            created_at: new Date().toISOString(),
        },
    };
});
