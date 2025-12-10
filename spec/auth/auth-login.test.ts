/**
 * Phase 1 Auth Tests - Password Login
 *
 * Tests for password-based authentication:
 * - auth:login with valid/invalid credentials
 * - auth:logout
 * - Session revalidation
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Auth, ROOT_USER_ID, DEFAULT_ROOT_PASSWORD } from '@src/auth/index.js';
import { EMS } from '@src/ems/ems.js';
import { BunHAL } from '@src/hal/index.js';

describe('Auth Phase 1', () => {
    let hal: BunHAL;
    let ems: EMS;
    let auth: Auth;

    beforeEach(async () => {
        hal = new BunHAL();
        ems = new EMS(hal);
        await ems.init();

        auth = new Auth(hal, ems, { allowAnonymous: false });
        await auth.init();
    });

    afterEach(async () => {
        await auth.shutdown();
        await ems.shutdown();
    });

    describe('initialization', () => {
        it('should seed root user on init', async () => {
            // Root user should exist after init
            const users = [];

            for await (const user of ems.ops.selectAny('auth_user', { where: { id: ROOT_USER_ID } })) {
                users.push(user);
            }

            expect(users.length).toBe(1);
            expect(users[0]!.username).toBe('root');
        });

        it('should not duplicate root user on repeated init', async () => {
            // Create another Auth instance and init again
            const auth2 = new Auth(hal, ems, { allowAnonymous: false });

            await auth2.init();

            // Should still have only one root user
            const users = [];

            for await (const user of ems.ops.selectAny('auth_user', { where: { username: 'root' } })) {
                users.push(user);
            }

            expect(users.length).toBe(1);

            await auth2.shutdown();
        });
    });

    describe('login', () => {
        it('should login with correct credentials', async () => {
            const result = await auth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).not.toBeNull();
            expect(result!.user).toBe(ROOT_USER_ID);
            expect(result!.session).toBeTruthy();
            expect(result!.token).toBeTruthy();
            expect(result!.expiresAt).toBeGreaterThan(Date.now());
        });

        it('should reject login with wrong password', async () => {
            const result = await auth.login('root', 'wrongpassword');

            expect(result).toBeNull();
        });

        it('should reject login with unknown username', async () => {
            const result = await auth.login('nonexistent', 'anypassword');

            expect(result).toBeNull();
        });

        it('should create session in EMS on login', async () => {
            const result = await auth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).not.toBeNull();

            // Session should exist in EMS
            const sessions = [];

            for await (const session of ems.ops.selectAny('auth_session', { where: { id: result!.session } })) {
                sessions.push(session);
            }

            expect(sessions.length).toBe(1);
            expect(sessions[0]!.user_id).toBe(ROOT_USER_ID);
        });

        it('should return valid JWT on login', async () => {
            const result = await auth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).not.toBeNull();

            // Validate the JWT
            const payload = await auth.validateToken(result!.token);

            expect(payload).not.toBeNull();
            expect(payload!.sub).toBe(ROOT_USER_ID);
            expect(payload!.sid).toBe(result!.session);
        });
    });

    describe('logout', () => {
        it('should invalidate session on logout', async () => {
            // Login first
            const result = await auth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).not.toBeNull();

            // Logout
            await auth.logout(result!.session);

            // Session should be soft-deleted
            const sessions = [];

            for await (const session of ems.ops.selectAny('auth_session', { where: { id: result!.session } })) {
                sessions.push(session);
            }

            // Session is soft-deleted, so it still exists but has trashed_at set
            // Actually, selectAny excludes trashed by default
            expect(sessions.length).toBe(0);
        });

        it('should not fail on logout with invalid session', async () => {
            // Should not throw
            await expect(auth.logout('nonexistent-session-id')).resolves.toBeUndefined();
        });
    });

    describe('session revalidation', () => {
        it('should return true for valid session', async () => {
            const result = await auth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).not.toBeNull();

            const valid = await auth.revalidateSession(result!.session);

            expect(valid).toBe(true);
        });

        it('should return false for revoked session', async () => {
            const result = await auth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).not.toBeNull();

            // Logout to revoke
            await auth.logout(result!.session);

            const valid = await auth.revalidateSession(result!.session);

            expect(valid).toBe(false);
        });

        it('should return false for nonexistent session', async () => {
            const valid = await auth.revalidateSession('nonexistent-session-id');

            expect(valid).toBe(false);
        });

        it('should return false for expired session', async () => {
            // Create auth with very short TTL
            const shortAuth = new Auth(hal, ems, {
                allowAnonymous: false,
                sessionTTL: 1, // 1ms TTL
            });

            await shortAuth.init();

            const result = await shortAuth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).not.toBeNull();

            // Wait for expiry
            await new Promise(resolve => setTimeout(resolve, 10));

            const valid = await shortAuth.revalidateSession(result!.session);

            expect(valid).toBe(false);

            await shortAuth.shutdown();
        });
    });

    describe('disabled user', () => {
        it('should reject login for disabled user', async () => {
            // Disable the root user
            for await (const _ of ems.ops.updateIds('auth_user', [ROOT_USER_ID], { disabled: 1 })) {
                // consume iterator
            }

            const result = await auth.login('root', DEFAULT_ROOT_PASSWORD);

            expect(result).toBeNull();

            // Re-enable for cleanup
            for await (const _ of ems.ops.updateIds('auth_user', [ROOT_USER_ID], { disabled: 0 })) {
                // consume iterator
            }
        });
    });
});
