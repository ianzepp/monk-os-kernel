import type { Context } from 'hono';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

/**
 * POST /api/user/sudo - Elevate user privileges to sudo level
 *
 * Generates short-lived sudo token for protected operations.
 * Requires existing user JWT and sufficient base privileges (root or full).
 *
 * Access levels:
 * - root: Automatically has is_sudo=true at login, can request sudo token for audit trail
 * - full: Can request sudo token to elevate privileges temporarily
 * - edit/read/deny: Cannot request sudo tokens
 */
export default async function (context: Context) {
    const userJwt = context.get('jwtPayload');
    const user = context.get('user');

    if (!userJwt || !user) {
        throw HttpErrors.unauthorized('Authorization token required', 'AUTH_TOKEN_REQUIRED');
    }

    // Validate user can escalate privileges (root or full users only)
    if (user.access !== 'root' && user.access !== 'full') {
        throw HttpErrors.forbidden(
            `Insufficient privileges for sudo - requires 'root' or 'full' access level (current: '${user.access}')`,
            'AUTH_SUDO_ACCESS_DENIED'
        );
    }

    // Extract optional reason for audit trail
    const { reason } = await context.req.json().catch(() => ({ reason: 'Administrative operation' }));

    // Generate short-lived sudo token (15 minutes)
    const sudoToken = await JWTGenerator.generateSudoToken(
        {
            id: user.id,
            user_id: user.id,
            username: user.username,
            tenant: user.tenant,
            dbName: user.db, // Extract from JWT compact field
            nsName: user.ns, // Extract from JWT compact field
            access: user.access,
            access_read: user.access_read || [],
            access_edit: user.access_edit || [],
            access_full: user.access_full || [],
        },
        { reason }
    );

    // Log sudo escalation for security audit
    console.warn('Sudo elevation granted', {
        user_id: user.id,
        tenant: user.tenant,
        access_level: user.access,
        reason: reason,
        expires_in: 900
    });

    return context.json({
        success: true,
        data: {
            sudo_token: sudoToken,
            expires_in: 900,
            token_type: 'Bearer',
            access_level: user.access,
            is_sudo: true,
            warning: 'Sudo token expires in 15 minutes',
            reason: reason
        }
    });
}
