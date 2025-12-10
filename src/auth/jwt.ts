/**
 * JWT Implementation - JSON Web Token signing and verification
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides JWT signing and verification using HMAC-SHA256.
 * It implements the minimal subset of JWT needed for authentication:
 * - HS256 algorithm only (symmetric signing)
 * - Standard header/payload/signature structure
 * - Base64URL encoding (no padding)
 *
 * No external dependencies - uses Bun's WebCrypto API directly.
 *
 * JWT Structure:
 *   header.payload.signature
 *
 * Where:
 * - header: Base64URL-encoded JSON with {alg: "HS256", typ: "JWT"}
 * - payload: Base64URL-encoded JSON with claims (sub, sid, exp, iat)
 * - signature: Base64URL-encoded HMAC-SHA256 of "header.payload"
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: sign() always produces valid JWT format (3 dot-separated parts)
 * INV-2: verify() returns null for invalid/expired/tampered tokens
 * INV-3: verify(sign(payload)) === payload (round-trip identity)
 * INV-4: Signature uses HMAC-SHA256 (constant-time comparison on verify)
 *
 * CONCURRENCY MODEL
 * =================
 * All operations are stateless and async. The signing key is passed explicitly
 * to each operation. No shared mutable state.
 *
 * SECURITY CONSIDERATIONS
 * =======================
 * - Uses constant-time comparison for signature verification (via crypto.subtle)
 * - Key must be at least 256 bits (32 bytes) for HS256 security
 * - Expiration is checked during verification
 * - No algorithm confusion attacks (we only support HS256)
 *
 * @module auth/jwt
 */

import type { JWTHeader, JWTPayload } from './types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Standard JWT header for HS256.
 *
 * WHY: We only support HS256, so header is constant. Pre-encode it.
 */
const _JWT_HEADER: JWTHeader = {
    alg: 'HS256',
    typ: 'JWT',
};

/**
 * Pre-encoded header (Base64URL of JSON).
 *
 * WHY: Header is constant, so we can compute it once.
 * This is Base64URL of '{"alg":"HS256","typ":"JWT"}'
 */
const ENCODED_HEADER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';

// =============================================================================
// BASE64URL ENCODING
// =============================================================================

/**
 * Encode bytes to Base64URL (no padding).
 *
 * WHY: JWT uses Base64URL encoding (URL-safe variant) without padding.
 * Standard Base64 uses +/ which are URL-unsafe, and = padding is optional
 * per RFC 7515.
 *
 * ALGORITHM:
 * 1. Convert to standard Base64
 * 2. Replace + with -, / with _
 * 3. Remove = padding
 *
 * @param data - Bytes to encode
 * @returns Base64URL string (no padding)
 */
function base64UrlEncode(data: Uint8Array): string {
    // Convert to Base64 using built-in
    const base64 = btoa(String.fromCharCode(...data));

    // Convert to Base64URL (replace +/ with -_, remove padding)
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Decode Base64URL to bytes.
 *
 * WHY: Need to decode JWT parts for verification and payload extraction.
 *
 * ALGORITHM:
 * 1. Replace - with +, _ with /
 * 2. Add padding if needed (Base64 requires length % 4 === 0)
 * 3. Decode standard Base64
 *
 * @param str - Base64URL string
 * @returns Decoded bytes
 * @throws Error if invalid Base64URL
 */
function base64UrlDecode(str: string): Uint8Array {
    // Convert from Base64URL to Base64
    let base64 = str
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    // Add padding if needed
    const padding = base64.length % 4;

    if (padding === 2) {
        base64 += '==';
    }
    else if (padding === 3) {
        base64 += '=';
    }

    // Decode Base64
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

/**
 * Encode string to Base64URL.
 *
 * @param str - String to encode
 * @returns Base64URL string
 */
function stringToBase64Url(str: string): string {
    return base64UrlEncode(new TextEncoder().encode(str));
}

/**
 * Decode Base64URL to string.
 *
 * @param str - Base64URL string
 * @returns Decoded string
 */
function base64UrlToString(str: string): string {
    return new TextDecoder().decode(base64UrlDecode(str));
}

// =============================================================================
// HMAC OPERATIONS
// =============================================================================

/**
 * Compute HMAC-SHA256 signature.
 *
 * WHY: JWT HS256 uses HMAC-SHA256 for signing. We use crypto.subtle for
 * secure, constant-time operations.
 *
 * @param key - Signing key (raw bytes)
 * @param data - Data to sign
 * @returns HMAC-SHA256 signature
 */
async function hmacSign(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    // Import key for HMAC
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );

    // Sign data
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);

    return new Uint8Array(signature);
}

/**
 * Verify HMAC-SHA256 signature.
 *
 * WHY: Uses crypto.subtle.verify for constant-time comparison, preventing
 * timing attacks.
 *
 * @param key - Signing key (raw bytes)
 * @param data - Data that was signed
 * @param signature - Signature to verify
 * @returns true if signature is valid
 */
async function hmacVerify(key: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    // Import key for HMAC verification
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
    );

    // Verify signature (constant-time comparison)
    return crypto.subtle.verify('HMAC', cryptoKey, signature, data);
}

// =============================================================================
// JWT OPERATIONS
// =============================================================================

/**
 * Sign a JWT payload.
 *
 * ALGORITHM:
 * 1. Encode header (pre-computed constant)
 * 2. Encode payload as JSON then Base64URL
 * 3. Compute signature = HMAC-SHA256(key, header.payload)
 * 4. Return header.payload.signature
 *
 * @param payload - JWT payload (claims)
 * @param key - Signing key (should be at least 32 bytes)
 * @returns JWT string (header.payload.signature)
 */
export async function signJWT(payload: JWTPayload, key: Uint8Array): Promise<string> {
    // Encode payload
    const encodedPayload = stringToBase64Url(JSON.stringify(payload));

    // Create signing input
    const signingInput = `${ENCODED_HEADER}.${encodedPayload}`;

    // Compute signature
    const signature = await hmacSign(key, new TextEncoder().encode(signingInput));
    const encodedSignature = base64UrlEncode(signature);

    // Return complete JWT
    return `${signingInput}.${encodedSignature}`;
}

/**
 * Verify and decode a JWT.
 *
 * ALGORITHM:
 * 1. Split into 3 parts (header.payload.signature)
 * 2. Verify header is HS256 JWT
 * 3. Verify signature matches
 * 4. Decode payload
 * 5. Check expiration if present
 * 6. Return payload or null if invalid
 *
 * SECURITY:
 * - Uses constant-time signature comparison
 * - Checks expiration before returning
 * - Returns null on any error (no error details to attacker)
 *
 * @param token - JWT string
 * @param key - Signing key
 * @returns Decoded payload, or null if invalid/expired
 */
export async function verifyJWT(token: string, key: Uint8Array): Promise<JWTPayload | null> {
    try {
        // Split into parts
        const parts = token.split('.');

        if (parts.length !== 3) {
            return null;
        }

        const [encodedHeader, encodedPayload, encodedSignature] = parts;

        // Verify header is what we expect
        // WHY: Prevents algorithm confusion attacks
        if (encodedHeader !== ENCODED_HEADER) {
            // Try to decode and check if it's a different algorithm
            try {
                const header = JSON.parse(base64UrlToString(encodedHeader!)) as JWTHeader;

                if (header.alg !== 'HS256' || header.typ !== 'JWT') {
                    return null;
                }
            }
            catch {
                return null;
            }
        }

        // Verify signature
        const signingInput = `${encodedHeader}.${encodedPayload}`;
        const signature = base64UrlDecode(encodedSignature!);
        const valid = await hmacVerify(key, new TextEncoder().encode(signingInput), signature);

        if (!valid) {
            return null;
        }

        // Decode payload
        const payload = JSON.parse(base64UrlToString(encodedPayload!)) as JWTPayload;

        // Check expiration
        // WHY <=: JWT exp is "at or after which" token must not be accepted
        if (payload.exp !== undefined) {
            const now = Math.floor(Date.now() / 1000);

            if (payload.exp <= now) {
                return null;
            }
        }

        // Validate required claims
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
            return null;
        }

        return payload;
    }
    catch {
        // Any error = invalid token
        return null;
    }
}

/**
 * Generate a random signing key.
 *
 * WHY: For ephemeral key generation at boot. Uses crypto.getRandomValues
 * for cryptographically secure randomness.
 *
 * @param size - Key size in bytes (default: 32 for HS256)
 * @returns Random key bytes
 */
export function generateKey(size: number = 32): Uint8Array {
    const key = new Uint8Array(size);

    crypto.getRandomValues(key);

    return key;
}
