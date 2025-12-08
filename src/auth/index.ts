/**
 * Auth Subsystem - Authentication for Monk OS
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Auth subsystem handles identity ("who are you?"). It's a peer subsystem
 * alongside VFS/EMS/Kernel, not a layer that intercepts other operations.
 *
 * Phase 0 (Bootstrap Auth MVP):
 * - auth:token - Validate JWT, set process identity
 * - auth:whoami - Return current identity
 * - Ephemeral signing key (tokens invalidate on restart)
 * - No password login, no EMS sessions
 *
 * Future phases:
 * - Phase 1: Password login, EMS session storage
 * - Phase 2: Session management, auth:passwd, auth:grant
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
} from './types.js';

export { DEFAULT_AUTH_CONFIG } from './types.js';

// Re-export JWT utilities (for kernel/init script token minting)
export { signJWT, verifyJWT, generateKey } from './jwt.js';
