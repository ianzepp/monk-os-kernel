/**
 * API Key Generation and Validation
 *
 * API keys follow the format: mk_{env}_{random}
 * - mk: Monk prefix
 * - env: Environment (live, test, dev)
 * - random: 32 random bytes as hex (64 chars)
 *
 * Only the SHA-256 hash of the key is stored in the database.
 * The full key is shown once at creation and never again.
 */

import { createHash, randomBytes } from 'crypto';

export type ApiKeyEnvironment = 'live' | 'test' | 'dev';

export interface GeneratedApiKey {
    /** Full API key (shown once, never stored) */
    key: string;
    /** Prefix for identification (e.g., mk_live_abc123) - first 16 chars */
    prefix: string;
    /** SHA-256 hash of the full key (stored in database) */
    hash: string;
    /** Algorithm used for hashing */
    algorithm: 'sha256';
}

export interface ParsedApiKey {
    /** Full key */
    key: string;
    /** Environment extracted from key */
    environment: ApiKeyEnvironment;
    /** Prefix (first 16 chars including mk_env_) */
    prefix: string;
    /** Random portion */
    secret: string;
}

/**
 * Generate a new API key
 *
 * @param environment - Environment for the key (live, test, dev)
 * @returns Generated key with prefix and hash
 */
export function generateApiKey(environment: ApiKeyEnvironment = 'live'): GeneratedApiKey {
    // Generate 32 random bytes (256 bits of entropy)
    const randomPart = randomBytes(32).toString('hex');

    // Full key format: mk_{env}_{random}
    const key = `mk_${environment}_${randomPart}`;

    // Prefix is first 16 chars for identification
    const prefix = key.substring(0, 16);

    // Hash the full key for storage
    const hash = hashApiKey(key);

    return {
        key,
        prefix,
        hash,
        algorithm: 'sha256',
    };
}

/**
 * Hash an API key for storage/comparison
 *
 * @param key - Full API key
 * @returns SHA-256 hash of the key
 */
export function hashApiKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}

/**
 * Parse an API key to extract its components
 *
 * @param key - Full API key
 * @returns Parsed key components or null if invalid format
 */
export function parseApiKey(key: string): ParsedApiKey | null {
    const match = key.match(/^mk_(live|test|dev)_([a-f0-9]{64})$/);
    if (!match) {
        return null;
    }

    return {
        key,
        environment: match[1] as ApiKeyEnvironment,
        prefix: key.substring(0, 16),
        secret: match[2],
    };
}

/**
 * Validate an API key format (does not verify against database)
 *
 * @param key - Key to validate
 * @returns true if format is valid
 */
export function isValidApiKeyFormat(key: string): boolean {
    return parseApiKey(key) !== null;
}

/**
 * Verify an API key against a stored hash
 *
 * @param key - Full API key to verify
 * @param storedHash - Hash stored in database
 * @returns true if key matches hash
 */
export function verifyApiKey(key: string, storedHash: string): boolean {
    const keyHash = hashApiKey(key);
    // Constant-time comparison to prevent timing attacks
    if (keyHash.length !== storedHash.length) {
        return false;
    }

    let result = 0;
    for (let i = 0; i < keyHash.length; i++) {
        result |= keyHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    return result === 0;
}
