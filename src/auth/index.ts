/**
 * Auth Subsystem - Authentication for Monk OS
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Auth subsystem handles identity ("who are you?"). It's a peer subsystem
 * alongside VFS/EMS/Kernel, not a layer that intercepts other operations.
 *
 * Phase 0 (Bootstrap Auth MVP): Complete
 * - auth:token - Validate JWT, set process identity
 * - auth:whoami - Return current identity
 * - Ephemeral signing key (tokens invalidate on restart)
 *
 * Phase 1 (Password Login): Complete
 * - auth:login - Password authentication
 * - auth:logout - Session invalidation
 * - EMS session storage for revocation
 * - 5-min session revalidation
 *
 * Future phases:
 * - Phase 2: auth:passwd, auth:grant, auth:register
 * - Phase 3: VFS permission checks against proc.user
 * - Phase 4: Subsystem-level scopes
 *
 * @module auth
 */

// Re-export main class
export { Auth } from './auth.js';

// Re-export types
export type {
    JWTHeader,
    JWTPayload,
    TokenResult,
    WhoamiResult,
    AuthConfig,
    LoginResult,
    AuthUser,
    AuthSession,
} from './types.js';

export {
    DEFAULT_AUTH_CONFIG,
    ROOT_USER_ID,
    DEFAULT_ROOT_PASSWORD,
    REVALIDATE_INTERVAL,
} from './types.js';

// Re-export JWT utilities (for kernel/init script token minting)
export { signJWT, verifyJWT, generateKey } from './jwt.js';
