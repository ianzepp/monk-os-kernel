import type { Context } from 'hono';
import { verify, sign } from 'hono/jwt';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { DatabaseConnection } from '@src/lib/database-connection.js';
import type { JWTPayload } from '@src/lib/jwt-generator.js';

/**
 * POST /auth/refresh - Refresh JWT token using valid token
 *
 * Accepts a valid JWT token and issues a new token with extended expiration.
 * Verifies that the user and tenant still exist and are active before issuing
 * a new token. This allows clients to extend their session without re-authenticating.
 *
 * Error codes:
 * - AUTH_TOKEN_REQUIRED: Missing token field (400)
 * - AUTH_TOKEN_INVALID: Invalid or corrupted token (401)
 * - AUTH_TOKEN_REFRESH_FAILED: Token valid but user/tenant no longer exists (401)
 *
 * @see docs/routes/AUTH_API.md
 */
export default async function (context: Context) {
    const { token } = await context.req.json();

    // Input validation
    if (!token) {
        throw HttpErrors.badRequest('Token is required for refresh', 'AUTH_TOKEN_REQUIRED');
    }

    let payload: JWTPayload;

    // Verify and decode the token
    try {
        payload = (await verify(token, process.env.JWT_SECRET!)) as JWTPayload;
    } catch (error: any) {
        // Handle JWT verification errors (invalid signature, malformed)
        // Note: Refresh endpoint accepts expired tokens - that's the whole point
        // Only reject if token is invalid (bad signature, corrupted)
        return context.json(
            {
                success: false,
                error: 'Invalid token',
                error_code: 'AUTH_TOKEN_INVALID',
            },
            401
        );
    }

    // Reject fake (impersonation) tokens - they have a hard expiry and cannot be refreshed
    // This prevents indefinite extension of impersonation sessions
    if (payload.is_fake) {
        return context.json(
            {
                success: false,
                error: 'Impersonation tokens cannot be refreshed - request a new fake token instead',
                error_code: 'AUTH_FAKE_TOKEN_REFRESH_DENIED',
            },
            403
        );
    }

    // Verify tenant still exists and is active
    const authDb = DatabaseConnection.getMainPool();
    const tenantResult = await authDb.query(
        'SELECT name, db_type, database, schema FROM tenants WHERE name = $1 AND is_active = true AND trashed_at IS NULL AND deleted_at IS NULL',
        [payload.tenant]
    );

    if (!tenantResult.rows || tenantResult.rows.length === 0) {
        return context.json(
            {
                success: false,
                error: 'Invalid or expired token',
                error_code: 'AUTH_TOKEN_REFRESH_FAILED',
            },
            401
        );
    }

    const { name: tenantName, db_type: dbType, database: dbName, schema: nsName } = tenantResult.rows[0];

    // Verify user still exists and is not deleted
    const userResult = await DatabaseConnection.queryInNamespace(
        dbName,
        nsName,
        'SELECT id, name, auth, access, access_read, access_edit, access_full, access_deny FROM users WHERE id = $1 AND trashed_at IS NULL AND deleted_at IS NULL',
        [payload.sub]
    );

    if (!userResult.rows || userResult.rows.length === 0) {
        return context.json(
            {
                success: false,
                error: 'Invalid or expired token',
                error_code: 'AUTH_TOKEN_REFRESH_FAILED',
            },
            401
        );
    }

    const user = userResult.rows[0];

    // Generate new JWT token with refreshed expiration
    const newPayload: JWTPayload = {
        sub: user.id,
        user_id: user.id,
        username: user.auth,
        tenant: tenantName,
        db_type: dbType || 'postgresql', // Database backend type (default for legacy tenants)
        db: dbName, // Compact JWT field
        ns: nsName, // Compact JWT field
        access: user.access,
        access_read: user.access_read || [],
        access_edit: user.access_edit || [],
        access_full: user.access_full || [],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
        is_sudo: user.access === 'root',
        // Preserve format preference from original token
        ...(payload.format && { format: payload.format }),
        // Note: fake tokens are rejected above, so no need to preserve is_fake metadata
    };

    const newToken = await sign(newPayload, process.env.JWT_SECRET!);

    return context.json({
        success: true,
        data: {
            token: newToken,
            expires_in: 24 * 60 * 60, // seconds
            user: {
                id: user.id,
                username: user.auth,
                tenant: tenantName,
                access: user.access,
                ...(newPayload.format && { format: newPayload.format }),
            },
        },
    });
}
