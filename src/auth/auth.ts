/**
 * Auth - Authentication Subsystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Auth subsystem handles identity ("who are you?"), not authorization
 * ("what can you do?"). It's a peer subsystem alongside VFS/EMS/Kernel.
 *
 * Auth responsibilities:
 * - Validate JWTs via auth:token
 * - Report identity via auth:whoami
 * - Set proc.user, proc.session, proc.expires on success
 *
 * Auth does NOT:
 * - Intercept other syscalls (dispatcher gates)
 * - Own the permission model (VFS/EMS check proc.user against ACLs)
 * - Manage processes (kernel does that)
 *
 * Phase 0 (Bootstrap Auth MVP):
 * - Ephemeral signing key (generated at init, lost on restart)
 * - JWT validation via auth:token
 * - Identity reporting via auth:whoami
 * - No password login (deferred to Phase 1)
 * - No EMS session storage (JWT expiry only)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: signingKey is non-null after init() completes
 * INV-2: validateToken() returns null for invalid/expired tokens
 * INV-3: mintToken() always produces valid JWTs
 * INV-4: All tokens signed with same ephemeral key until shutdown
 *
 * CONCURRENCY MODEL
 * =================
 * Auth is stateless except for the signing key. All token operations are
 * independent and can run concurrently. The signing key is immutable after
 * init().
 *
 * SECURITY CONSIDERATIONS
 * =======================
 * - Ephemeral key: All tokens invalidate on OS restart (acceptable for Phase 0)
 * - No session storage: Cannot revoke individual tokens (future: EMS sessions)
 * - HMAC-SHA256: Secure symmetric signing
 * - Constant-time verification: Prevents timing attacks
 *
 * @module auth/auth
 */

import type { HAL } from '@src/hal/index.js';
import type { JWTPayload, TokenResult, WhoamiResult, AuthConfig } from './types.js';
import { DEFAULT_AUTH_CONFIG } from './types.js';
import { signJWT, verifyJWT, generateKey } from './jwt.js';

// =============================================================================
// AUTH CLASS
// =============================================================================

/**
 * Authentication subsystem.
 *
 * Manages identity and JWT operations. Initialized during boot, generates
 * ephemeral signing key that lives until shutdown.
 */
export class Auth {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * Auth configuration.
     *
     * WHY: Allows runtime configuration of session TTL, anonymous access, etc.
     */
    private readonly config: Required<AuthConfig>;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * JWT signing key.
     *
     * WHY: Ephemeral key generated at init. All JWTs are signed with this key.
     * Lost on restart, invalidating all tokens (acceptable for Phase 0).
     *
     * INVARIANT: Non-null after init() completes.
     */
    private signingKey: Uint8Array | null = null;

    /**
     * HAL reference for entropy.
     *
     * WHY: Need UUID generation for session IDs.
     */
    private readonly hal: HAL;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create Auth subsystem.
     *
     * @param hal - HAL for entropy (UUID generation)
     * @param config - Optional configuration
     */
    constructor(hal: HAL, config?: AuthConfig) {
        this.hal = hal;
        this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
    }

    /**
     * Initialize Auth subsystem.
     *
     * ALGORITHM:
     * 1. Generate ephemeral signing key (32 bytes for HS256)
     *
     * WHY ephemeral: Phase 0 doesn't persist keys. Tokens invalidate on restart.
     * This is acceptable because the DB is also ephemeral (recreated each boot).
     */
    async init(): Promise<void> {
        // Generate ephemeral signing key
        // WHY 32 bytes: HS256 requires at least 256-bit key
        this.signingKey = generateKey(32);
    }

    /**
     * Shutdown Auth subsystem.
     *
     * ALGORITHM:
     * 1. Clear signing key (invalidates all tokens)
     *
     * WHY clear key: Ensures tokens can't be validated after shutdown.
     */
    async shutdown(): Promise<void> {
        this.signingKey = null;
    }

    // =========================================================================
    // TOKEN OPERATIONS
    // =========================================================================

    /**
     * Mint a new JWT for a principal.
     *
     * WHY: Used by internal code (init scripts, kernel) to create tokens
     * for services and users. Phase 0 has no auth:login, so tokens are
     * minted directly.
     *
     * ALGORITHM:
     * 1. Generate session ID (UUID)
     * 2. Compute expiry from TTL
     * 3. Create JWT payload with claims
     * 4. Sign and return JWT
     *
     * @param principal - User/service ID (e.g., 'root', 'svc:httpd')
     * @param ttl - Token TTL in ms (default: config.sessionTTL)
     * @returns Token result with JWT and metadata
     */
    async mintToken(principal: string, ttl?: number): Promise<TokenResult> {
        if (!this.signingKey) {
            throw new Error('Auth not initialized');
        }

        const sessionId = this.hal.entropy.uuid();
        const now = Date.now();
        const effectiveTTL = ttl ?? this.config.sessionTTL;
        const expiresAt = now + effectiveTTL;

        const payload: JWTPayload = {
            sub: principal,
            sid: sessionId,
            iat: Math.floor(now / 1000),
            exp: Math.floor(expiresAt / 1000),
        };

        const token = await signJWT(payload, this.signingKey);

        return {
            user: principal,
            session: sessionId,
            token,
            expiresAt,
        };
    }

    /**
     * Validate a JWT and return payload.
     *
     * WHY: Used by auth:token syscall and dispatcher gating.
     *
     * ALGORITHM:
     * 1. Verify JWT signature and expiry
     * 2. Return payload if valid, null if invalid
     *
     * @param token - JWT string
     * @returns Payload if valid, null if invalid/expired
     */
    async validateToken(token: string): Promise<JWTPayload | null> {
        if (!this.signingKey) {
            return null;
        }

        return verifyJWT(token, this.signingKey);
    }

    /**
     * Validate JWT and return fresh token (sliding expiration).
     *
     * WHY: auth:token syscall validates the provided JWT and returns a fresh
     * one with extended expiry. This enables sliding expiration without
     * separate refresh tokens.
     *
     * ALGORITHM:
     * 1. Validate provided JWT
     * 2. If valid, mint fresh JWT with same principal/session
     * 3. Return fresh token result
     *
     * @param token - JWT string to validate
     * @returns Fresh token result, or null if invalid
     */
    async refreshToken(token: string): Promise<TokenResult | null> {
        const payload = await this.validateToken(token);

        if (!payload) {
            return null;
        }

        // Mint fresh token with same principal
        // WHY new session: Could reuse sid, but generating new one is cleaner
        // for Phase 0. Phase 1 with EMS sessions will track session continuity.
        return this.mintToken(payload.sub);
    }

    // =========================================================================
    // CONFIGURATION ACCESSORS
    // =========================================================================

    /**
     * Check if anonymous access is allowed.
     *
     * WHY: Dispatcher uses this to decide whether to enforce auth gating.
     */
    isAnonymousAllowed(): boolean {
        return this.config.allowAnonymous;
    }

    /**
     * Get session TTL in milliseconds.
     */
    getSessionTTL(): number {
        return this.config.sessionTTL;
    }
}
