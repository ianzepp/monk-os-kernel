/**
 * Phase 2 Auth Tests - Registration and Token Granting
 *
 * Tests for:
 * - auth:register - Create user accounts
 * - auth:grant - Mint scoped tokens (root only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Auth } from '@src/auth/index.js';
import { EMS } from '@src/ems/ems.js';
import { BunHAL } from '@src/hal/index.js';

describe('Auth Phase 2', () => {
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

    // =========================================================================
    // auth:register
    // =========================================================================

    describe('register', () => {
        it('should create a new user', async () => {
            const userId = await auth.register('alice', 'password123');

            expect(userId).not.toBeNull();
            expect(typeof userId).toBe('string');
        });

        it('should allow login with new user credentials', async () => {
            const userId = await auth.register('alice', 'password123');
            const result = await auth.login('alice', 'password123');

            expect(result).not.toBeNull();
            expect(result!.user).toBe(userId!);
        });

        it('should reject duplicate username', async () => {
            await auth.register('alice', 'password123');
            const duplicate = await auth.register('alice', 'different');

            expect(duplicate).toBeNull();
        });

        it('should allow multiple unique users', async () => {
            const alice = await auth.register('alice', 'pass1');
            const bob = await auth.register('bob', 'pass2');

            expect(alice).not.toBeNull();
            expect(bob).not.toBeNull();
            expect(alice).not.toBe(bob);
        });

        it('should reject registration with root username', async () => {
            // Root is seeded on init, so registration should fail
            const result = await auth.register('root', 'newpassword');

            expect(result).toBeNull();
        });
    });

    // =========================================================================
    // auth:grant
    // =========================================================================

    describe('grant', () => {
        it('should mint a token for a principal', async () => {
            const result = await auth.grant('svc:monitor');

            expect(result.user).toBe('svc:monitor');
            expect(result.session).toBeTruthy();
            expect(result.token).toBeTruthy();
            expect(result.expiresAt).toBeGreaterThan(Date.now());
        });

        it('should create a session in EMS', async () => {
            const result = await auth.grant('svc:monitor');

            // Session should exist in EMS
            const sessions = [];

            for await (const session of ems.ops.selectAny('auth_session', { where: { id: result.session } })) {
                sessions.push(session);
            }

            expect(sessions.length).toBe(1);
            expect(sessions[0]!.user_id).toBe('svc:monitor');
        });

        it('should include scopes in JWT', async () => {
            const result = await auth.grant('svc:monitor', ['read']);

            // Validate the token contains the scope
            const payload = await auth.validateToken(result.token);

            expect(payload).not.toBeNull();
            expect(payload!.sub).toBe('svc:monitor');
            expect(payload!.scope).toEqual(['read']);
        });

        it('should use default TTL when not specified', async () => {
            const before = Date.now();
            const result = await auth.grant('svc:monitor');
            const after = Date.now();

            // Default TTL is 24 hours
            const expectedMin = before + (24 * 60 * 60 * 1000);
            const expectedMax = after + (24 * 60 * 60 * 1000);

            expect(result.expiresAt).toBeGreaterThanOrEqual(expectedMin);
            expect(result.expiresAt).toBeLessThanOrEqual(expectedMax);
        });

        it('should respect custom TTL', async () => {
            const customTTL = 60 * 1000; // 1 minute
            const before = Date.now();
            const result = await auth.grant('svc:monitor', undefined, customTTL);
            const after = Date.now();

            expect(result.expiresAt).toBeGreaterThanOrEqual(before + customTTL);
            expect(result.expiresAt).toBeLessThanOrEqual(after + customTTL);
        });

        it('should allow granting multiple scopes', async () => {
            const result = await auth.grant('svc:monitor', ['read', 'write', 'vfs:read']);

            const payload = await auth.validateToken(result.token);

            expect(payload!.scope).toEqual(['read', 'write', 'vfs:read']);
        });

        it('should work without scopes (unrestricted)', async () => {
            const result = await auth.grant('svc:admin');

            const payload = await auth.validateToken(result.token);

            expect(payload!.scope).toBeUndefined();
        });

        it('should allow service principals to authenticate with granted token', async () => {
            const granted = await auth.grant('svc:httpd', ['read']);

            // Token should be valid
            const payload = await auth.validateToken(granted.token);

            expect(payload).not.toBeNull();
            expect(payload!.sub).toBe('svc:httpd');
        });
    });
});
