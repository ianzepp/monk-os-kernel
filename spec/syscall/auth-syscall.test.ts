/**
 * Auth Syscall Tests
 *
 * Tests for auth:token, auth:whoami syscalls and dispatcher auth gating.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import { Auth } from '@src/auth/index.js';
import type { Process } from '@src/kernel/types.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { EMS } from '@src/ems/ems.js';
import type { HAL } from '@src/hal/index.js';
import type { Response } from '@src/message.js';
import { BunEntropyDevice } from '@src/hal/entropy.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock process for testing.
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        user: 'anonymous',
        worker: {} as Worker,
        virtual: false,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/home/test',
        env: { HOME: '/home/test', PATH: '/bin' },
        args: [],
        pathDirs: new Map([['00-bin', '/bin']]),
        handles: new Map(),
        nextHandle: 3,
        children: new Map(),
        nextPid: 1,
        activeStreams: new Map(),
        streamPingHandlers: new Map(),
        // Auth fields - undefined by default (unauthenticated)
        session: undefined,
        expires: undefined,
        sessionValidatedAt: undefined,
        sessionData: undefined,
        ...overrides,
    };
}

/**
 * Create minimal mock dependencies.
 */
function createMockDeps() {
    const mockKernel = {
        processes: {
            get: () => undefined,
            all: () => [],
        },
        vfs: {},
        poolManager: {
            stats: () => ({ pools: {} }),
        },
    } as unknown as Kernel;

    const mockVfs = {} as unknown as VFS;
    const mockEms = {} as unknown as EMS;

    // Real entropy for UUID generation
    const mockHal = {
        entropy: new BunEntropyDevice(),
    } as unknown as HAL;

    return { mockKernel, mockVfs, mockEms, mockHal };
}

/**
 * Get first response from a dispatch.
 */
async function firstResponse(
    dispatcher: SyscallDispatcher,
    proc: Process,
    name: string,
    args: unknown[],
): Promise<Response> {
    for await (const response of dispatcher.dispatch(proc, name, args)) {
        return response;
    }

    throw new Error('No response received');
}

// =============================================================================
// TESTS
// =============================================================================

describe('Auth Syscalls', () => {
    let dispatcher: SyscallDispatcher;
    let auth: Auth;
    let mockHal: HAL;
    let proc: Process;

    beforeEach(async () => {
        const mocks = createMockDeps();

        mockHal = mocks.mockHal;

        // Create real Auth instance (no EMS for Phase 0 tests)
        auth = new Auth(mockHal, undefined, { allowAnonymous: true });
        await auth.init();

        dispatcher = new SyscallDispatcher(
            mocks.mockKernel,
            mocks.mockVfs,
            mocks.mockEms,
            mocks.mockHal,
            auth,
        );

        proc = createMockProcess();
    });

    afterEach(async () => {
        await auth.shutdown();
    });

    // =========================================================================
    // auth:token
    // =========================================================================

    describe('auth:token', () => {
        it('should validate JWT and return fresh token', async () => {
            // Mint a token first
            const original = await auth.mintToken('alice');

            // Call auth:token syscall
            const response = await firstResponse(dispatcher, proc, 'auth:token', [original.token]);

            expect(response.op).toBe('ok');

            const data = response.data as {
                user: string;
                session: string;
                token: string;
                expiresAt: number;
            };

            expect(data.user).toBe('alice');
            expect(data.session).toBeTruthy();
            expect(data.token).toBeTruthy();
            expect(data.token).not.toBe(original.token); // Fresh token
            expect(data.expiresAt).toBeGreaterThan(Date.now());
        });

        it('should set process identity fields', async () => {
            const original = await auth.mintToken('bob');

            // Process should be unauthenticated initially
            expect(proc.session).toBeUndefined();

            await firstResponse(dispatcher, proc, 'auth:token', [original.token]);

            // Process should now be authenticated
            expect(proc.user).toBe('bob');
            expect(proc.session).toBeTruthy();
            expect(proc.expires).toBeGreaterThan(Date.now());
            expect(proc.sessionValidatedAt).toBeLessThanOrEqual(Date.now());
        });

        it('should reject invalid token', async () => {
            const response = await firstResponse(dispatcher, proc, 'auth:token', ['invalid.token.here']);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EACCES');
            expect((response.data as { message: string }).message).toContain('Invalid or expired');
        });

        it('should reject expired token', async () => {
            // Mint token with 1 second TTL
            const original = await auth.mintToken('alice', 1000);

            // Wait for expiry
            await new Promise(resolve => setTimeout(resolve, 1100));

            const response = await firstResponse(dispatcher, proc, 'auth:token', [original.token]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EACCES');
        });

        it('should reject non-string jwt argument', async () => {
            const response = await firstResponse(dispatcher, proc, 'auth:token', [12345]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
            expect((response.data as { message: string }).message).toContain('jwt must be a string');
        });

        it('should reject missing jwt argument', async () => {
            const response = await firstResponse(dispatcher, proc, 'auth:token', []);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
        });
    });

    // =========================================================================
    // auth:whoami
    // =========================================================================

    describe('auth:whoami', () => {
        it('should return user and session for authenticated process', async () => {
            // Authenticate first
            const original = await auth.mintToken('charlie');
            await firstResponse(dispatcher, proc, 'auth:token', [original.token]);

            // Now call whoami
            const response = await firstResponse(dispatcher, proc, 'auth:whoami', []);

            expect(response.op).toBe('ok');

            const data = response.data as { user: string | null; session: string | null };

            expect(data.user).toBe('charlie');
            expect(data.session).toBeTruthy();
        });

        it('should return null for unauthenticated process', async () => {
            // Process is unauthenticated (no session)
            const response = await firstResponse(dispatcher, proc, 'auth:whoami', []);

            expect(response.op).toBe('ok');

            const data = response.data as { user: string | null; session: string | null };

            expect(data.user).toBeNull();
            expect(data.session).toBeNull();
        });
    });

    // =========================================================================
    // Dispatcher Auth Gating
    // =========================================================================

    describe('auth gating', () => {
        describe('with allowAnonymous: false', () => {
            let strictDispatcher: SyscallDispatcher;
            let strictAuth: Auth;

            beforeEach(async () => {
                const mocks = createMockDeps();

                strictAuth = new Auth(mocks.mockHal, undefined, { allowAnonymous: false });
                await strictAuth.init();

                strictDispatcher = new SyscallDispatcher(
                    mocks.mockKernel,
                    mocks.mockVfs,
                    mocks.mockEms,
                    mocks.mockHal,
                    strictAuth,
                );
            });

            afterEach(async () => {
                await strictAuth.shutdown();
            });

            it('should allow auth:token for unauthenticated process', async () => {
                const unauthProc = createMockProcess();
                const token = await strictAuth.mintToken('alice');

                const response = await firstResponse(strictDispatcher, unauthProc, 'auth:token', [token.token]);

                expect(response.op).toBe('ok');
            });

            it('should allow auth:login for unauthenticated process', async () => {
                const unauthProc = createMockProcess();

                // auth:login should be allowed for unauthenticated processes (not blocked by gating)
                // Without EMS, login will fail with EINVAL (bad args) rather than EACCES
                const response = await firstResponse(strictDispatcher, unauthProc, 'auth:login', []);

                // Fails with EINVAL because no args provided, not EACCES (auth required)
                expect(response.op).toBe('error');
                expect((response.data as { code: string }).code).toBe('EINVAL');
            });

            it('should allow auth:register for unauthenticated process', async () => {
                const unauthProc = createMockProcess();

                // auth:register is allowed for unauthenticated processes
                // Without EMS, register will fail with error (EMS required), not EACCES
                const response = await firstResponse(strictDispatcher, unauthProc, 'auth:register', [
                    { user: 'test', pass: 'test' },
                ]);

                // Fails because no EMS, but not blocked by auth gating
                expect(response.op).toBe('error');
                expect((response.data as { code: string }).code).not.toBe('EACCES');
            });

            it('should reject other syscalls for unauthenticated process', async () => {
                const unauthProc = createMockProcess();

                const response = await firstResponse(strictDispatcher, unauthProc, 'proc:getcwd', []);

                expect(response.op).toBe('error');
                expect((response.data as { code: string }).code).toBe('EACCES');
                expect((response.data as { message: string }).message).toBe('Authentication required');
            });

            it('should allow syscalls for authenticated process', async () => {
                const authProc = createMockProcess({
                    user: 'alice',
                    session: 'session-123',
                    expires: Date.now() + 60000,
                });

                const response = await firstResponse(strictDispatcher, authProc, 'proc:getcwd', []);

                expect(response.op).toBe('ok');
                expect(response.data).toBe('/home/test');
            });
        });

        describe('session expiry', () => {
            let strictDispatcher: SyscallDispatcher;
            let strictAuth: Auth;

            beforeEach(async () => {
                const mocks = createMockDeps();

                strictAuth = new Auth(mocks.mockHal, undefined, { allowAnonymous: false });
                await strictAuth.init();

                strictDispatcher = new SyscallDispatcher(
                    mocks.mockKernel,
                    mocks.mockVfs,
                    mocks.mockEms,
                    mocks.mockHal,
                    strictAuth,
                );
            });

            afterEach(async () => {
                await strictAuth.shutdown();
            });

            it('should clear expired session and reject syscall', async () => {
                const expiredProc = createMockProcess({
                    user: 'alice',
                    session: 'session-123',
                    expires: Date.now() - 1000, // Expired 1 second ago
                    sessionValidatedAt: Date.now() - 2000,
                    sessionData: { iat: 123 },
                });

                const response = await firstResponse(strictDispatcher, expiredProc, 'proc:getcwd', []);

                // Should be rejected
                expect(response.op).toBe('error');
                expect((response.data as { code: string }).code).toBe('EACCES');

                // Session should be cleared
                expect(expiredProc.user).toBe('anonymous');
                expect(expiredProc.session).toBeUndefined();
                expect(expiredProc.expires).toBeUndefined();
                expect(expiredProc.sessionValidatedAt).toBeUndefined();
                expect(expiredProc.sessionData).toBeUndefined();
            });

            it('should allow syscall with valid (non-expired) session', async () => {
                const validProc = createMockProcess({
                    user: 'alice',
                    session: 'session-123',
                    expires: Date.now() + 60000, // Expires in 1 minute
                });

                const response = await firstResponse(strictDispatcher, validProc, 'proc:getcwd', []);

                expect(response.op).toBe('ok');
                // Session should still be set
                expect(validProc.session).toBe('session-123');
            });
        });

        describe('with allowAnonymous: true', () => {
            it('should allow all syscalls regardless of auth status', async () => {
                // Default dispatcher has allowAnonymous: true
                const unauthProc = createMockProcess();

                const response = await firstResponse(dispatcher, unauthProc, 'proc:getcwd', []);

                expect(response.op).toBe('ok');
                expect(response.data).toBe('/home/test');
            });
        });
    });

    // =========================================================================
    // Auth not available
    // =========================================================================

    describe('auth not available', () => {
        it('should return ENOSYS when auth is undefined', async () => {
            const mocks = createMockDeps();

            const noAuthDispatcher = new SyscallDispatcher(
                mocks.mockKernel,
                mocks.mockVfs,
                mocks.mockEms,
                mocks.mockHal,
                undefined, // No auth
            );

            const response = await firstResponse(noAuthDispatcher, proc, 'auth:token', ['some.token']);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('ENOSYS');
            expect((response.data as { message: string }).message).toBe('Auth not available');
        });
    });

    // =========================================================================
    // Phase 2: auth:grant
    // =========================================================================

    describe('auth:grant', () => {
        it('should reject non-root caller', async () => {
            // Process is not root
            const nonRootProc = createMockProcess({
                user: 'alice',
                session: 'session-123',
                expires: Date.now() + 60000,
            });

            const response = await firstResponse(dispatcher, nonRootProc, 'auth:grant', [
                { principal: 'svc:test' },
            ]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EPERM');
            expect((response.data as { message: string }).message).toContain('Only root');
        });

        it('should reject missing principal', async () => {
            const rootProc = createMockProcess({
                user: '00000000-0000-0000-0000-000000000001', // ROOT_USER_ID
                session: 'session-123',
                expires: Date.now() + 60000,
            });

            const response = await firstResponse(dispatcher, rootProc, 'auth:grant', [{}]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
            expect((response.data as { message: string }).message).toContain('principal');
        });

        it('should reject invalid scope type', async () => {
            const rootProc = createMockProcess({
                user: '00000000-0000-0000-0000-000000000001',
                session: 'session-123',
                expires: Date.now() + 60000,
            });

            const response = await firstResponse(dispatcher, rootProc, 'auth:grant', [
                { principal: 'svc:test', scope: 'read' }, // Should be array
            ]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
            expect((response.data as { message: string }).message).toContain('scope');
        });

        it('should reject invalid ttl', async () => {
            const rootProc = createMockProcess({
                user: '00000000-0000-0000-0000-000000000001',
                session: 'session-123',
                expires: Date.now() + 60000,
            });

            const response = await firstResponse(dispatcher, rootProc, 'auth:grant', [
                { principal: 'svc:test', ttl: -1000 },
            ]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
            expect((response.data as { message: string }).message).toContain('ttl');
        });

        it('should mint token for root caller', async () => {
            const rootProc = createMockProcess({
                user: '00000000-0000-0000-0000-000000000001',
                session: 'session-123',
                expires: Date.now() + 60000,
            });

            const response = await firstResponse(dispatcher, rootProc, 'auth:grant', [
                { principal: 'svc:monitor', scope: ['read'] },
            ]);

            expect(response.op).toBe('ok');

            const data = response.data as {
                principal: string;
                session: string;
                token: string;
                expiresAt: number;
                scope: string[];
            };

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
            const response = await firstResponse(dispatcher, proc, 'auth:register', []);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
        });

        it('should reject missing user', async () => {
            const response = await firstResponse(dispatcher, proc, 'auth:register', [
                { pass: 'secret' },
            ]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
            expect((response.data as { message: string }).message).toContain('user');
        });

        it('should reject empty user', async () => {
            const response = await firstResponse(dispatcher, proc, 'auth:register', [
                { user: '', pass: 'secret' },
            ]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
        });

        it('should reject missing pass', async () => {
            const response = await firstResponse(dispatcher, proc, 'auth:register', [
                { user: 'alice' },
            ]);

            expect(response.op).toBe('error');
            expect((response.data as { code: string }).code).toBe('EINVAL');
            expect((response.data as { message: string }).message).toContain('pass');
        });
    });
});
