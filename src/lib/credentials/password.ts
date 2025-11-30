/**
 * Password Hashing Utilities
 *
 * Uses Bun's built-in Argon2id implementation for secure password hashing.
 * Argon2id is the recommended algorithm per OWASP 2024 guidelines.
 */

/**
 * Hash a password using Argon2id
 *
 * @param password - Plain text password to hash
 * @returns Hashed password string (includes algorithm, salt, and hash)
 */
export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password, {
        algorithm: 'argon2id',
        memoryCost: 65536, // 64 MB
        timeCost: 3,       // 3 iterations
    });
}

/**
 * Verify a password against a stored hash
 *
 * @param password - Plain text password to verify
 * @param hash - Stored hash to compare against
 * @returns true if password matches, false otherwise
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
        return await Bun.password.verify(password, hash);
    } catch {
        // Invalid hash format or other error
        return false;
    }
}

/**
 * Check if a password hash needs to be rehashed
 * (e.g., if algorithm parameters have changed)
 *
 * @param hash - Stored hash to check
 * @returns true if hash should be regenerated
 */
export function needsRehash(hash: string): boolean {
    // Bun.password hashes start with $argon2id$
    // If hash doesn't match current algorithm, it needs rehashing
    return !hash.startsWith('$argon2id$');
}
