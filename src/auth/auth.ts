/**
 * Auth - Authentication Subsystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Auth subsystem handles identity ("who are you?"), not authorization
 * ("what can you do?"). It's a peer subsystem alongside VFS/EMS/Kernel.
 *
 * Auth responsibilities:
 * - Handle auth:* syscalls (login, logout, token, whoami)
 * - Validate credentials (password, JWT)
 * - Store sessions in EMS
 * - Set proc.user, proc.session, proc.expires on success
 *
 * Auth does NOT:
 * - Intercept other syscalls (dispatcher gates)
 * - Own the permission model (VFS/EMS check proc.user against ACLs)
 * - Manage processes (kernel does that)
 *
 * Phase 0 (Bootstrap Auth MVP): Complete
 * - Ephemeral signing key (generated at init, lost on restart)
 * - JWT validation via auth:token
 * - Identity reporting via auth:whoami
 *
 * Phase 1 (Password Login): This implementation
 * - Password login via auth:login (argon2id)
 * - Session storage in EMS (auth_session table)
 * - Session logout via auth:logout
 * - 5-min EMS revalidation for session revocation
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: signingKey is non-null after init() completes
 * INV-2: validateToken() returns null for invalid/expired tokens
 * INV-3: mintToken() always produces valid JWTs
 * INV-4: All tokens signed with same ephemeral key until shutdown
 * INV-5: Root user exists after init() completes (Phase 1)
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
 * - Session storage: Can revoke individual sessions via EMS (Phase 1)
 * - HMAC-SHA256: Secure symmetric signing
 * - Argon2id: Memory-hard password hashing (Phase 1)
 * - Constant-time verification: Prevents timing attacks
 *
 * @module auth/auth
 */

import type { HAL } from '@src/hal/index.js';
import type { EMS } from '@src/ems/ems.js';
import { collect } from '@src/ems/entity-ops.js';
import type { JWTPayload, TokenResult, AuthConfig, LoginResult, AuthUser, AuthSession } from './types.js';
import { DEFAULT_AUTH_CONFIG, ROOT_USER_ID, DEFAULT_ROOT_PASSWORD, REVALIDATE_INTERVAL } from './types.js';
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
     * HAL reference for entropy and crypto.
     *
     * WHY: Need UUID generation for session IDs and password hashing.
     */
    private readonly hal: HAL;

    /**
     * EMS reference for session/user storage.
     *
     * WHY: Phase 1 stores sessions and users in EMS for persistence and
     * revocation support. Optional for backward compatibility.
     */
    private readonly ems: EMS | undefined;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create Auth subsystem.
     *
     * @param hal - HAL for entropy (UUID generation) and crypto
     * @param ems - EMS for session/user storage (optional)
     * @param config - Optional configuration
     */
    constructor(hal: HAL, ems?: EMS, config?: AuthConfig) {
        this.hal = hal;
        this.ems = ems;
        this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
    }

    /**
     * Initialize Auth subsystem.
     *
     * ALGORITHM:
     * 1. Generate ephemeral signing key (32 bytes for HS256)
     * 2. Load auth schema into EMS (Phase 1)
     * 3. Seed root user if not exists (Phase 1)
     *
     * WHY ephemeral key: Phase 0 doesn't persist keys. Tokens invalidate on
     * restart. This is acceptable because the DB is also ephemeral.
     */
    async init(): Promise<void> {
        // Generate ephemeral signing key
        // WHY 32 bytes: HS256 requires at least 256-bit key
        this.signingKey = generateKey(32);

        // Phase 1: Load auth schema and seed root user
        if (this.ems) {
            await this.loadSchema();
            await this.seedRootUser();
        }
    }

    /**
     * Load auth models into EMS.
     *
     * WHY: Creates auth_user and auth_session tables on first boot.
     * Uses JSON model definitions imported via ems.importModel().
     */
    private async loadSchema(): Promise<void> {
        if (!this.ems) {
            return;
        }

        const modelNames = ['auth_user', 'auth_session'];

        for (const name of modelNames) {
            const jsonPath = new URL(`./models/${name}.json`, import.meta.url).pathname;
            const jsonText = await this.hal.file.readText(jsonPath);
            const definition = JSON.parse(jsonText) as Record<string, unknown>;

            await this.ems.importModel(name, definition);
        }
    }

    /**
     * Seed root user if not exists.
     *
     * WHY: Ensures a root user exists for initial authentication.
     * Password is hashed with argon2id for security.
     */
    private async seedRootUser(): Promise<void> {
        if (!this.ems) {
            return;
        }

        // Check if root user exists
        const users = await collect(
            this.ems.ops.selectAny<AuthUser>('auth_user', {
                where: { id: ROOT_USER_ID },
            }),
        );

        if (users.length > 0) {
            return;
        }

        // Hash default password
        const passwordHash = await this.hashPassword(DEFAULT_ROOT_PASSWORD);

        // Create root user
        await collect(
            this.ems.ops.createAll<AuthUser>('auth_user', [{
                id: ROOT_USER_ID,
                username: 'root',
                password_hash: passwordHash,
                disabled: 0,
            } as Partial<AuthUser>]),
        );
    }

    /**
     * Hash a password using argon2id.
     *
     * WHY: Argon2id is memory-hard, resistant to GPU/ASIC attacks.
     * Returns the full hash string including salt and parameters.
     */
    private async hashPassword(password: string): Promise<string> {
        const passwordBytes = new TextEncoder().encode(password);
        const salt = new Uint8Array(16); // Ignored by argon2id (generates own salt)
        const hashBytes = await this.hal.crypto.derive('argon2id', passwordBytes, salt);

        return new TextDecoder().decode(hashBytes);
    }

    /**
     * Verify a password against a stored hash.
     *
     * WHY: Uses constant-time comparison to prevent timing attacks.
     */
    private async verifyPassword(password: string, hash: string): Promise<boolean> {
        const passwordBytes = new TextEncoder().encode(password);
        const hashBytes = new TextEncoder().encode(hash);

        return this.hal.crypto.verify(hashBytes, passwordBytes);
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
    // PHASE 1: PASSWORD LOGIN
    // =========================================================================

    /**
     * Login with username and password.
     *
     * WHY: Phase 1 password authentication. Validates credentials against
     * auth_user table, creates session in auth_session table, returns JWT.
     *
     * ALGORITHM:
     * 1. Look up user by username
     * 2. Verify password hash
     * 3. Check user not disabled
     * 4. Create session in EMS
     * 5. Mint JWT with session ID
     * 6. Return login result
     *
     * @param username - Username to authenticate
     * @param password - Password to verify
     * @returns Login result with JWT, or null if invalid credentials
     */
    async login(username: string, password: string): Promise<LoginResult | null> {
        if (!this.signingKey) {
            throw new Error('Auth not initialized');
        }

        if (!this.ems) {
            throw new Error('EMS required for password login');
        }

        // Look up user by username
        const users = await collect(
            this.ems.ops.selectAny<AuthUser>('auth_user', {
                where: { username },
            }),
        );

        const user = users[0];

        if (!user) {
            return null;
        }

        // Check user not disabled
        if (user.disabled) {
            return null;
        }

        // Verify password
        const valid = await this.verifyPassword(password, user.password_hash);

        if (!valid) {
            return null;
        }

        // Create session
        const sessionId = this.hal.entropy.uuid();
        const now = Date.now();
        const expiresAt = now + this.config.sessionTTL;

        await collect(
            this.ems.ops.createAll<AuthSession>('auth_session', [{
                id: sessionId,
                user_id: user.id,
                expires: expiresAt,
            } as Partial<AuthSession>]),
        );

        // Mint JWT
        const payload: JWTPayload = {
            sub: user.id,
            sid: sessionId,
            iat: Math.floor(now / 1000),
            exp: Math.floor(expiresAt / 1000),
        };

        const token = await signJWT(payload, this.signingKey);

        return {
            user: user.id,
            session: sessionId,
            token,
            expiresAt,
        };
    }

    /**
     * Logout and invalidate session.
     *
     * WHY: Allows users to explicitly end their session. Deletes session
     * from EMS so it cannot be reused.
     *
     * ALGORITHM:
     * 1. Delete session from EMS (soft delete)
     * 2. Return success
     *
     * @param sessionId - Session ID to invalidate
     */
    async logout(sessionId: string): Promise<void> {
        if (!this.ems) {
            return;
        }

        // Soft delete the session
        try {
            await collect(this.ems.ops.deleteIds('auth_session', [sessionId]));
        }
        catch {
            // Session may not exist - ignore
        }
    }

    /**
     * Revalidate a session against EMS.
     *
     * WHY: Allows session revocation to propagate. If a session was deleted
     * or expired in EMS, this will detect it and return false.
     *
     * ALGORITHM:
     * 1. Look up session in EMS
     * 2. Check session exists and not expired
     * 3. Return validity
     *
     * @param sessionId - Session ID to validate
     * @returns True if session is valid, false if revoked/expired
     */
    async revalidateSession(sessionId: string): Promise<boolean> {
        if (!this.ems) {
            // No EMS - can't revalidate, assume valid
            return true;
        }

        const sessions = await collect(
            this.ems.ops.selectAny<AuthSession>('auth_session', {
                where: { id: sessionId },
            }),
        );

        const session = sessions[0];

        if (!session) {
            return false;
        }

        // Check not expired
        if (session.expires < Date.now()) {
            return false;
        }

        return true;
    }

    /**
     * Get the revalidation interval in milliseconds.
     *
     * WHY: Dispatcher uses this to determine when to check EMS for session
     * validity. Returns the configured interval (default 5 minutes).
     */
    getRevalidateInterval(): number {
        return REVALIDATE_INTERVAL;
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

    // =========================================================================
    // PHASE 2: USER REGISTRATION
    // =========================================================================

    /**
     * Register a new user account.
     *
     * WHY: Allows new users to create accounts. Password is hashed with
     * argon2id before storage.
     *
     * ALGORITHM:
     * 1. Check username not already taken
     * 2. Hash password with argon2id
     * 3. Create user in EMS
     * 4. Return user ID
     *
     * @param username - Username for the new account
     * @param password - Password to hash and store
     * @returns User ID if created, null if username taken
     */
    async register(username: string, password: string): Promise<string | null> {
        if (!this.ems) {
            throw new Error('EMS required for user registration');
        }

        // Check username not taken
        const existing = await collect(
            this.ems.ops.selectAny<AuthUser>('auth_user', {
                where: { username },
            }),
        );

        if (existing.length > 0) {
            return null;
        }

        // Hash password
        const passwordHash = await this.hashPassword(password);

        // Create user
        const userId = this.hal.entropy.uuid();

        await collect(
            this.ems.ops.createAll<AuthUser>('auth_user', [{
                id: userId,
                username,
                password_hash: passwordHash,
                disabled: 0,
            } as Partial<AuthUser>]),
        );

        return userId;
    }

    // =========================================================================
    // PHASE 2: TOKEN GRANTING
    // =========================================================================

    /**
     * Mint a scoped token for a principal.
     *
     * WHY: Allows root or internal OS code to create tokens for services
     * and users with specific scope restrictions.
     *
     * TODO: Phase 4 - Enforce scope checking in dispatcher. Currently scopes
     * are stored in JWT but not validated on syscall execution.
     *
     * ALGORITHM:
     * 1. Generate session ID
     * 2. Create session in EMS (for revocation)
     * 3. Mint JWT with principal, session, and scopes
     * 4. Return token result
     *
     * @param principal - User/service ID (e.g., 'svc:httpd')
     * @param scope - Permission scopes (e.g., ['read'], ['vfs:read'])
     * @param ttl - Token TTL in ms (default: config.sessionTTL)
     * @returns Token result with JWT and metadata
     */
    async grant(principal: string, scope?: string[], ttl?: number): Promise<TokenResult> {
        if (!this.signingKey) {
            throw new Error('Auth not initialized');
        }

        const sessionId = this.hal.entropy.uuid();
        const now = Date.now();
        const effectiveTTL = ttl ?? this.config.sessionTTL;
        const expiresAt = now + effectiveTTL;

        // Create session in EMS for revocation support
        if (this.ems) {
            await collect(
                this.ems.ops.createAll<AuthSession>('auth_session', [{
                    id: sessionId,
                    user_id: principal,
                    expires: expiresAt,
                } as Partial<AuthSession>]),
            );
        }

        // Build JWT payload with scopes
        const payload: JWTPayload = {
            sub: principal,
            sid: sessionId,
            iat: Math.floor(now / 1000),
            exp: Math.floor(expiresAt / 1000),
        };

        if (scope && scope.length > 0) {
            payload.scope = scope;
        }

        const token = await signJWT(payload, this.signingKey);

        return {
            user: principal,
            session: sessionId,
            token,
            expiresAt,
        };
    }
}
