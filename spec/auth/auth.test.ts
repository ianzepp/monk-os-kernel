/**
 * Auth Subsystem Tests
 *
 * Tests for the Auth class.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Auth } from '@src/auth/auth.js';
import { verifyJWT } from '@src/auth/jwt.js';
import type { HAL } from '@src/hal/index.js';
import { BunEntropyDevice } from '@src/hal/entropy.js';

// Create minimal mock HAL with real entropy
function createMockHAL(): HAL {
    return {
        entropy: new BunEntropyDevice(),
    } as HAL;
}

describe('Auth', () => {
    let hal: HAL;
    let auth: Auth;

    beforeEach(async () => {
        hal = createMockHAL();
        auth = new Auth(hal);
        await auth.init();
    });

    afterEach(async () => {
        await auth.shutdown();
    });

    describe('init/shutdown', () => {
        it('should initialize successfully', async () => {
            const newAuth = new Auth(hal);
            await newAuth.init();

            // Should be able to mint tokens after init
            const result = await newAuth.mintToken('test-user');

            expect(result.user).toBe('test-user');
            expect(result.token).toBeTruthy();

            await newAuth.shutdown();
        });

        it('should throw if mintToken called before init', async () => {
            const uninitAuth = new Auth(hal);

            await expect(uninitAuth.mintToken('test-user')).rejects.toThrow('Auth not initialized');
        });

        it('should return null from validateToken after shutdown', async () => {
            const result = await auth.mintToken('test-user');
            await auth.shutdown();

            const decoded = await auth.validateToken(result.token);

            expect(decoded).toBeNull();
        });
    });

    describe('mintToken', () => {
        it('should return token result with all fields', async () => {
            const result = await auth.mintToken('alice');

            expect(result.user).toBe('alice');
            expect(result.session).toBeTruthy();
            expect(result.token).toBeTruthy();
            expect(result.expiresAt).toBeGreaterThan(Date.now());
        });

        it('should generate unique session IDs', async () => {
            const result1 = await auth.mintToken('alice');
            const result2 = await auth.mintToken('alice');

            expect(result1.session).not.toBe(result2.session);
        });

        it('should use configured TTL', async () => {
            const ttl = 60 * 1000; // 1 minute
            const before = Date.now();
            const result = await auth.mintToken('alice', ttl);
            const after = Date.now();

            // expiresAt should be roughly now + ttl
            expect(result.expiresAt).toBeGreaterThanOrEqual(before + ttl);
            expect(result.expiresAt).toBeLessThanOrEqual(after + ttl);
        });

        it('should produce valid JWTs', async () => {
            const result = await auth.mintToken('alice');
            const decoded = await auth.validateToken(result.token);

            expect(decoded).not.toBeNull();
            expect(decoded!.sub).toBe('alice');
            expect(decoded!.sid).toBe(result.session);
        });
    });

    describe('validateToken', () => {
        it('should validate tokens from mintToken', async () => {
            const result = await auth.mintToken('alice');
            const decoded = await auth.validateToken(result.token);

            expect(decoded).not.toBeNull();
            expect(decoded!.sub).toBe('alice');
        });

        it('should return null for invalid token', async () => {
            const decoded = await auth.validateToken('invalid.token.here');

            expect(decoded).toBeNull();
        });

        it('should return null for expired token', async () => {
            // Mint with 1 second TTL (JWT exp is in seconds)
            const result = await auth.mintToken('alice', 1000); // 1s TTL

            // Wait for expiry
            await new Promise(resolve => setTimeout(resolve, 1100));

            const decoded = await auth.validateToken(result.token);

            expect(decoded).toBeNull();
        });

        it('should return null for token from different Auth instance', async () => {
            const otherAuth = new Auth(hal);
            await otherAuth.init();

            const result = await otherAuth.mintToken('alice');
            const decoded = await auth.validateToken(result.token);

            expect(decoded).toBeNull();

            await otherAuth.shutdown();
        });
    });

    describe('refreshToken', () => {
        it('should return fresh token for valid input', async () => {
            const original = await auth.mintToken('alice');
            const refreshed = await auth.refreshToken(original.token);

            expect(refreshed).not.toBeNull();
            expect(refreshed!.user).toBe('alice');
            expect(refreshed!.token).not.toBe(original.token);
        });

        it('should return null for invalid token', async () => {
            const refreshed = await auth.refreshToken('invalid.token.here');

            expect(refreshed).toBeNull();
        });

        it('should return null for expired token', async () => {
            // Use 1 second TTL since JWT exp is in seconds
            const original = await auth.mintToken('alice', 1000); // 1s TTL
            await new Promise(resolve => setTimeout(resolve, 1100)); // Wait for expiry

            const refreshed = await auth.refreshToken(original.token);

            expect(refreshed).toBeNull();
        });

        it('should extend expiry on refresh', async () => {
            const ttl = 60 * 1000;
            const original = await auth.mintToken('alice', ttl);

            // Small delay
            await new Promise(resolve => setTimeout(resolve, 10));

            const refreshed = await auth.refreshToken(original.token);

            // New token should have later expiry
            expect(refreshed!.expiresAt).toBeGreaterThan(original.expiresAt);
        });
    });

    describe('configuration', () => {
        it('should respect allowAnonymous config', async () => {
            const noAnonAuth = new Auth(hal, { allowAnonymous: false });
            await noAnonAuth.init();

            expect(noAnonAuth.isAnonymousAllowed()).toBe(false);

            await noAnonAuth.shutdown();
        });

        it('should respect sessionTTL config', async () => {
            const customTTL = 60 * 60 * 1000; // 1 hour
            const customAuth = new Auth(hal, { sessionTTL: customTTL });
            await customAuth.init();

            expect(customAuth.getSessionTTL()).toBe(customTTL);

            await customAuth.shutdown();
        });

        it('should use default config values', () => {
            expect(auth.isAnonymousAllowed()).toBe(false);
            expect(auth.getSessionTTL()).toBe(24 * 60 * 60 * 1000); // 24 hours
        });
    });
});
