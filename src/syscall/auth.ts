/**
 * Auth Syscall Handlers
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * These syscall handlers implement the auth:* syscalls. They bridge between
 * the syscall layer and the Auth subsystem.
 *
 * Phase 0 syscalls:
 * - auth:token - Validate JWT, set process identity, return fresh token
 * - auth:whoami - Return current user/session info
 *
 * Future syscalls (Phase 1+):
 * - auth:login - Password login
 * - auth:logout - Clear session
 * - auth:passwd - Change password
 * - auth:grant - Mint scoped tokens
 * - auth:register - Create user account
 *
 * @module syscall/auth
 */

import type { Process, Response } from './types.js';
import { respond } from './types.js';
import type { Auth } from '@src/auth/index.js';

// =============================================================================
// AUTH SYSCALLS
// =============================================================================

/**
 * auth:token - Validate JWT and set process identity.
 *
 * ALGORITHM:
 * 1. Validate jwt argument
 * 2. Validate token via Auth subsystem
 * 3. If valid, set process identity fields
 * 4. Return fresh token (sliding expiration)
 *
 * WHY sliding expiration: Clients don't need separate refresh tokens.
 * auth:token always returns a fresh JWT with extended expiry.
 *
 * @param proc - Calling process
 * @param auth - Auth subsystem
 * @param jwt - JWT token to validate
 */
export async function* authToken(
    proc: Process,
    auth: Auth,
    jwt: unknown,
): AsyncIterable<Response> {
    // Validate argument
    if (typeof jwt !== 'string') {
        yield respond.error('EINVAL', 'jwt must be a string');

        return;
    }

    // Validate token and get fresh one
    const result = await auth.refreshToken(jwt);

    if (!result) {
        yield respond.error('EACCES', 'Invalid or expired token');

        return;
    }

    // Set process identity
    // WHY: Dispatcher will use these fields for subsequent auth checks
    proc.user = result.user;
    proc.session = result.session;
    proc.expires = result.expiresAt;
    proc.sessionValidatedAt = Date.now();

    // Return fresh token
    yield respond.ok({
        user: result.user,
        session: result.session,
        token: result.token,
        expiresAt: result.expiresAt,
    });
}

/**
 * auth:whoami - Return current user/session info.
 *
 * ALGORITHM:
 * 1. Check if process has authenticated identity
 * 2. Return user/session info (or null if anonymous)
 *
 * WHY return null instead of error for anonymous: Allows clients to check
 * "am I logged in?" without catching exceptions.
 *
 * NOTE: This syscall requires authentication (not in ALLOW_ANONYMOUS).
 * Anonymous processes won't reach this handler.
 *
 * @param proc - Calling process
 */
export async function* authWhoami(
    proc: Process,
): AsyncIterable<Response> {
    yield respond.ok({
        user: proc.session ? proc.user : null,
        session: proc.session ?? null,
    });
}
