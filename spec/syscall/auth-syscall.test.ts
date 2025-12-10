/**
 * Auth Syscall Tests
 *
 * Tests for auth:token, auth:whoami syscalls and dispatcher auth gating.
 *
 * WHY: These tests validate the syscall layer through the real dispatch chain.
 * Uses TestOS with dispatcher layer to test syscall validation and behavior
 * without mocks, ensuring real integration between syscall handlers and Auth.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestOS } from '@src/os/test.js';

describe('Auth Syscalls', () => {
    let os: TestOS;

    beforeEach(async () => {
        os = new TestOS();
        await os.boot({ layers: ['dispatcher'] });
    });

    afterEach(async () => {
        await os.shutdown();
    });

    // =========================================================================
    // auth:token
    // =========================================================================

    describe('auth:token', () => {
        it('should validate JWT and return fresh token', async () => {
            const original = await os.internalAuth.mintToken('alice');

            const data = await os.syscall<{
                user: string;
                session: string;
                token: string;
                expiresAt: number;
            }>('auth:token', original.token);

            expect(data.user).toBe('alice');
            expect(data.session).toBeTruthy();
            expect(data.token).toBeTruthy();
            expect(data.token).not.toBe(original.token);
            expect(data.expiresAt).toBeGreaterThan(Date.now());
        });

        it('should set process identity fields', async () => {
            const original = await os.internalAuth.mintToken('bob');

            await os.syscall('auth:token', original.token);

            const proc = os.getTestProcess();

            expect(proc.user).toBe('bob');
            expect(proc.session).toBeTruthy();
            expect(proc.expires).toBeGreaterThan(Date.now());
            expect(proc.sessionValidatedAt).toBeLessThanOrEqual(Date.now());
        });

        it('should reject invalid token', async () => {
            await expect(os.syscall('auth:token', 'invalid.token.here'))
                .rejects.toThrow('Invalid or expired');
        });

        it('should reject expired token', async () => {
            const original = await os.internalAuth.mintToken('alice', 1000);

            await new Promise(resolve => setTimeout(resolve, 1100));

            await expect(os.syscall('auth:token', original.token))
                .rejects.toThrow();
        });

        it('should reject non-string jwt argument', async () => {
            await expect(os.syscall('auth:token', 12345))
                .rejects.toThrow('jwt must be a string');
        });

        it('should reject missing jwt argument', async () => {
            await expect(os.syscall('auth:token'))
                .rejects.toThrow();
        });
    });

    // =========================================================================
    // auth:whoami
    // =========================================================================

    describe('auth:whoami', () => {
        it('should return user and session for authenticated process', async () => {
            const original = await os.internalAuth.mintToken('charlie');

            await os.syscall('auth:token', original.token);

            const data = await os.syscall<{ user: string | null; session: string | null }>('auth:whoami');

            expect(data.user).toBe('charlie');
            expect(data.session).toBeTruthy();
        });

        it('should return null for unauthenticated process', async () => {
            const data = await os.syscall<{ user: string | null; session: string | null }>('auth:whoami');

            expect(data.user).toBeNull();
            expect(data.session).toBeNull();
        });
    });

    // =========================================================================
    // Dispatcher Auth Gating
    // =========================================================================

    describe('auth gating', () => {
        describe('with allowAnonymous: false', () => {
            // WHY: TestOS currently only supports allowAnonymous: true
            // These tests require a separate OS instance with strict auth
            // TODO: Enhance TestOS to support auth configuration in boot options

            it.skip('should allow auth:token for unauthenticated process', async () => {
                // Requires allowAnonymous: false configuration
            });

            it.skip('should allow auth:login for unauthenticated process', async () => {
                // Requires allowAnonymous: false configuration
            });

            it.skip('should allow auth:register for unauthenticated process', async () => {
                // Requires allowAnonymous: false configuration
            });

            it.skip('should reject other syscalls for unauthenticated process', async () => {
                // Requires allowAnonymous: false configuration
            });

            it.skip('should allow syscalls for authenticated process', async () => {
                // Requires allowAnonymous: false configuration
            });
        });

        describe('session expiry', () => {
            // WHY: TestOS currently only supports allowAnonymous: true
            // Session expiry tests require strict auth mode
            // TODO: Enhance TestOS to support auth configuration in boot options

            it.skip('should clear expired session and reject syscall', async () => {
                // Requires allowAnonymous: false configuration
            });

            it.skip('should allow syscall with valid (non-expired) session', async () => {
                // Requires allowAnonymous: false configuration
            });
        });

        describe('with allowAnonymous: true', () => {
            it('should allow all syscalls regardless of auth status', async () => {
                const result = await os.syscall<string>('proc:getcwd');

                expect(result).toBe('/');
            });
        });
    });

    // =========================================================================
    // Auth not available
    // =========================================================================

    describe('auth not available', () => {
        // WHY: TestOS always boots with Auth when dispatcher layer is enabled
        // Testing "no auth" scenario requires booting without auth layer
        // TODO: Add TestOS test for auth unavailable scenario

        it.skip('should return ENOSYS when auth is undefined', async () => {
            // Requires booting TestOS without auth layer
        });
    });

    // =========================================================================
    // Phase 2: auth:grant
    // =========================================================================

    describe('auth:grant', () => {
        it('should reject non-root caller', async () => {
            const token = await os.internalAuth.mintToken('alice');

            await os.syscall('auth:token', token.token);

            await expect(os.syscall('auth:grant', { principal: 'svc:test' }))
                .rejects.toThrow('Only root');
        });

        it('should reject missing principal', async () => {
            os.setTestUser('00000000-0000-0000-0000-000000000001');

            await expect(os.syscall('auth:grant', {}))
                .rejects.toThrow('principal');
        });

        it('should reject invalid scope type', async () => {
            os.setTestUser('00000000-0000-0000-0000-000000000001');

            await expect(os.syscall('auth:grant', { principal: 'svc:test', scope: 'read' }))
                .rejects.toThrow('scope');
        });

        it('should reject invalid ttl', async () => {
            os.setTestUser('00000000-0000-0000-0000-000000000001');

            await expect(os.syscall('auth:grant', { principal: 'svc:test', ttl: -1000 }))
                .rejects.toThrow('ttl');
        });

        it('should mint token for root caller', async () => {
            os.setTestUser('00000000-0000-0000-0000-000000000001');

            const data = await os.syscall<{
                principal: string;
                session: string;
                token: string;
                expiresAt: number;
                scope: string[];
            }>('auth:grant', { principal: 'svc:monitor', scope: ['read'] });

            expect(data.principal).toBe('svc:monitor');
            expect(data.session).toBeTruthy();
            expect(data.token).toBeTruthy();
            expect(data.expiresAt).toBeGreaterThan(Date.now());
            expect(data.scope).toEqual(['read']);
        });
    });

    // =========================================================================
    // Phase 2: auth:register (argument validation only - EMS tests in auth-phase2.test.ts)
    // =========================================================================

    describe('auth:register', () => {
        it('should reject missing args', async () => {
            await expect(os.syscall('auth:register'))
                .rejects.toThrow();
        });

        it('should reject missing user', async () => {
            await expect(os.syscall('auth:register', { pass: 'secret' }))
                .rejects.toThrow('user');
        });

        it('should reject empty user', async () => {
            await expect(os.syscall('auth:register', { user: '', pass: 'secret' }))
                .rejects.toThrow();
        });

        it('should reject missing pass', async () => {
            await expect(os.syscall('auth:register', { user: 'alice' }))
                .rejects.toThrow('pass');
        });
    });
});
