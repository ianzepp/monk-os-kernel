/**
 * Auth Types - Type definitions for the authentication subsystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * These types define the authentication layer's data structures. Auth handles
 * identity ("who are you?"), not authorization ("what can you do?"). Authorization
 * is handled by the existing ACL system in VFS.
 *
 * Key types:
 * - JWTHeader: Standard JWT header with alg and typ
 * - JWTPayload: Claims including sub (user), sid (session), exp (expiry)
 * - TokenResult: Response from auth:token syscall
 *
 * @module auth/types
 */

// =============================================================================
// JWT TYPES
// =============================================================================

/**
 * JWT header (JOSE header).
 *
 * WHY: Standard JWT format requires a header specifying algorithm and type.
 * We use HS256 (HMAC-SHA256) for symmetric signing.
 */
export interface JWTHeader {
    /** Algorithm - always 'HS256' for this implementation */
    alg: 'HS256';

    /** Type - always 'JWT' */
    typ: 'JWT';
}

/**
 * JWT payload (claims).
 *
 * WHY: Standard JWT claims plus our custom session ID. We use standard claim
 * names (sub, exp, iat) for interoperability.
 *
 * INVARIANTS:
 * - sub is always present (identifies the principal)
 * - sid is always present (identifies the session for revocation)
 * - exp is optional (no expiry = never expires)
 * - iat is always present (issued at timestamp)
 */
export interface JWTPayload {
    /** Subject - user/principal ID (standard claim) */
    sub: string;

    /** Session ID - for revocation tracking (custom claim) */
    sid: string;

    /** Expiration time - Unix timestamp in seconds (standard claim) */
    exp?: number;

    /** Issued at - Unix timestamp in seconds (standard claim) */
    iat: number;

    /** Scopes - permission scopes (custom claim, Phase 4) */
    scope?: string[];

    /** Allow additional claims */
    [key: string]: unknown;
}

// =============================================================================
// AUTH RESULT TYPES
// =============================================================================

/**
 * Result from auth:token syscall.
 *
 * WHY: Provides all information the client needs after successful authentication:
 * - user: The authenticated principal ID
 * - session: Session ID for tracking
 * - token: Fresh JWT for subsequent requests
 * - expiresAt: When the token expires (ms since epoch)
 */
export interface TokenResult {
    /** Authenticated user/principal ID */
    user: string;

    /** Session ID */
    session: string;

    /** Fresh JWT token */
    token: string;

    /** Token expiry timestamp (ms since epoch) */
    expiresAt: number;
}

/**
 * Result from auth:whoami syscall.
 *
 * WHY: Provides identity information for the current session.
 * If not authenticated, user and session will be null.
 */
export interface WhoamiResult {
    /** Current user ID (null if anonymous) */
    user: string | null;

    /** Current session ID (null if anonymous) */
    session: string | null;
}

// =============================================================================
// AUTH CONFIG TYPES
// =============================================================================

/**
 * Auth subsystem configuration.
 *
 * WHY: Allows tuning auth behavior without code changes.
 * All values have sensible defaults.
 */
export interface AuthConfig {
    /**
     * Session TTL in milliseconds.
     * Default: 24 hours (86400000)
     */
    sessionTTL?: number;

    /**
     * Whether to allow anonymous access (bypass gating).
     * Default: false
     *
     * WHY: Useful for testing and development.
     */
    allowAnonymous?: boolean;
}

/**
 * Default auth configuration values.
 */
export const DEFAULT_AUTH_CONFIG: Required<AuthConfig> = {
    sessionTTL: 24 * 60 * 60 * 1000, // 24 hours
    allowAnonymous: false,
};

// =============================================================================
// PHASE 1 TYPES
// =============================================================================

/**
 * Well-known UUID for the root user.
 *
 * WHY: Consistent identity across restarts, simplifies bootstrap.
 */
export const ROOT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Default root password.
 *
 * WHY: Allows testing without manual user creation.
 * In production, this should be changed immediately after first boot.
 */
export const DEFAULT_ROOT_PASSWORD = 'root';

/**
 * Session revalidation interval (5 minutes).
 *
 * WHY: Balances security (detect revoked sessions) with performance
 * (don't hit EMS on every syscall).
 */
export const REVALIDATE_INTERVAL = 5 * 60 * 1000;

/**
 * Result from auth:login syscall.
 *
 * WHY: Provides all information the client needs after successful login:
 * - user: The authenticated user ID
 * - session: Session ID for tracking
 * - token: JWT for subsequent requests
 * - expiresAt: When the session/token expires
 */
export interface LoginResult {
    /** Authenticated user ID */
    user: string;

    /** Session ID */
    session: string;

    /** JWT token */
    token: string;

    /** Token expiry timestamp (ms since epoch) */
    expiresAt: number;
}

/**
 * User record from auth_user table.
 */
export interface AuthUser {
    id: string;
    username: string;
    password_hash: string;
    disabled: boolean;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
    [key: string]: unknown;
}

/**
 * Session record from auth_session table.
 */
export interface AuthSession {
    id: string;
    user_id: string;
    expires: number;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
    updated_at: string;
    trashed_at: string | null;
    expired_at: string | null;
    [key: string]: unknown;
}
