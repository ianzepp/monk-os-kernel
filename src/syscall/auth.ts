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
 * Phase 1 syscalls:
 * - auth:login - Password login, create session, return JWT
 * - auth:logout - Clear session, reset process identity
 * - auth:session - Revalidate session against EMS (internal)
 *
 * Future syscalls (Phase 2+):
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

// =============================================================================
// PHASE 1 SYSCALLS
// =============================================================================

/**
 * auth:login - Password login.
 *
 * ALGORITHM:
 * 1. Validate arguments (username, password)
 * 2. Call Auth.login() to validate credentials
 * 3. If valid, set process identity fields
 * 4. Return login result with JWT
 *
 * @param proc - Calling process
 * @param auth - Auth subsystem
 * @param args - Login arguments { user, pass }
 */
export async function* authLogin(
    proc: Process,
    auth: Auth,
    args: unknown,
): AsyncIterable<Response> {
    // Validate arguments
    if (!args || typeof args !== 'object') {
        yield respond.error('EINVAL', 'args must be an object');

        return;
    }

    const { user, pass } = args as { user?: unknown; pass?: unknown };

    if (typeof user !== 'string' || !user) {
        yield respond.error('EINVAL', 'user must be a non-empty string');

        return;
    }

    if (typeof pass !== 'string') {
        yield respond.error('EINVAL', 'pass must be a string');

        return;
    }

    // Attempt login
    const result = await auth.login(user, pass);

    if (!result) {
        yield respond.error('EACCES', 'Invalid credentials');

        return;
    }

    // Set process identity
    proc.user = result.user;
    proc.session = result.session;
    proc.expires = result.expiresAt;
    proc.sessionValidatedAt = Date.now();

    // Return result
    yield respond.ok({
        user: result.user,
        session: result.session,
        token: result.token,
        expiresAt: result.expiresAt,
    });
}

/**
 * auth:logout - Clear session and reset process identity.
 *
 * ALGORITHM:
 * 1. Call Auth.logout() to invalidate session in EMS
 * 2. Clear process identity fields
 * 3. Return success
 *
 * @param proc - Calling process
 * @param auth - Auth subsystem
 */
export async function* authLogout(
    proc: Process,
    auth: Auth,
): AsyncIterable<Response> {
    // Invalidate session in EMS
    if (proc.session) {
        await auth.logout(proc.session);
    }

    // Clear process identity
    proc.user = 'anonymous';
    proc.session = undefined;
    proc.expires = undefined;
    proc.sessionValidatedAt = undefined;
    proc.sessionData = undefined;

    yield respond.ok({});
}

/**
 * auth:session - Revalidate session against EMS.
 *
 * WHY: Internal handler called by dispatcher to check if session is still
 * valid in EMS. This allows session revocation to propagate.
 *
 * ALGORITHM:
 * 1. Check if process has session and needs revalidation
 * 2. Call Auth.revalidateSession()
 * 3. If invalid, clear process identity
 * 4. Update sessionValidatedAt timestamp
 *
 * @param proc - Calling process
 * @param auth - Auth subsystem
 * @param action - Action to perform ('revalidate')
 */
export async function* authSession(
    proc: Process,
    auth: Auth,
    action: unknown,
): AsyncIterable<Response> {
    if (action !== 'revalidate') {
        yield respond.error('EINVAL', 'Invalid action');

        return;
    }

    // No session - nothing to revalidate
    if (!proc.session) {
        yield respond.ok({ valid: true });

        return;
    }

    // Check if revalidation is needed
    const revalidateInterval = auth.getRevalidateInterval();
    const lastValidated = proc.sessionValidatedAt ?? 0;

    if (Date.now() - lastValidated < revalidateInterval) {
        // Recently validated - skip
        yield respond.ok({ valid: true });

        return;
    }

    // Revalidate against EMS
    const valid = await auth.revalidateSession(proc.session);

    if (!valid) {
        // Session revoked or expired - clear identity
        proc.user = 'anonymous';
        proc.session = undefined;
        proc.expires = undefined;
        proc.sessionValidatedAt = undefined;
        proc.sessionData = undefined;

        yield respond.ok({ valid: false });

        return;
    }

    // Update validation timestamp
    proc.sessionValidatedAt = Date.now();

    yield respond.ok({ valid: true });
}
