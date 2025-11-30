/**
 * Key Derivation for Encryption
 *
 * Derives AES-256 encryption keys from JWT tokens using PBKDF2.
 * 
 * Security Model:
 * - JWT token serves as password material
 * - Salt is tenant:userId (deterministic per user)
 * - Same JWT always produces same key (allows decryption)
 * - JWT expiry means old encrypted messages become undecryptable
 * 
 * This is intentional - encryption is for transport security, not archival.
 */

import crypto from 'crypto';

/**
 * Derive AES-256 encryption key from JWT token
 * 
 * @param jwt - JWT token string (from Authorization header)
 * @param salt - Salt for key derivation (tenant:userId)
 * @returns 32-byte encryption key for AES-256
 */
export function deriveKeyFromJWT(jwt: string, salt: string): Buffer {
    if (!jwt || jwt.trim().length === 0) {
        throw new Error('JWT token is required for key derivation');
    }

    if (!salt || salt.trim().length === 0) {
        throw new Error('Salt is required for key derivation');
    }

    // PBKDF2 with high iteration count for security
    // 100,000 iterations is OWASP recommendation for 2024
    const key = crypto.pbkdf2Sync(
        jwt,            // Password: the JWT token itself
        salt,           // Salt: tenant:userId for user-specific keys
        100000,         // Iterations: computational cost
        32,             // Key length: 256 bits for AES-256
        'sha256'        // Hash algorithm
    );

    return key;
}

/**
 * Extract salt from JWT payload for key derivation
 * Salt format: "tenant:userId"
 *
 * @param jwtPayload - Decoded JWT payload
 * @returns Salt string in format "tenant:userId"
 */
export function extractSaltFromPayload(jwtPayload: any): string {
    const tenant = jwtPayload.tenant;
    const userId = jwtPayload.user_id || jwtPayload.sub;

    if (!tenant || !userId) {
        throw new Error('JWT payload missing tenant or user ID for salt generation');
    }

    return `${tenant}:${userId}`;
}
