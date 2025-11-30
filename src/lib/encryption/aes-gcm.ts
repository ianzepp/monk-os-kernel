/**
 * AES-256-GCM Encryption/Decryption
 *
 * Authenticated encryption using AES-256 in Galois/Counter Mode.
 * 
 * Features:
 * - AES-256-GCM: Authenticated encryption (confidentiality + integrity)
 * - Random IV per encryption (96 bits)
 * - Authentication tag prevents tampering (128 bits)
 * - Hardware-accelerated on modern CPUs (AES-NI)
 * 
 * Security Properties:
 * - Confidentiality: Plaintext is encrypted
 * - Integrity: Auth tag detects any modifications
 * - Authenticity: Only someone with the key can create valid ciphertext
 */

import crypto from 'crypto';

/**
 * Result of AES-256-GCM encryption
 */
export interface EncryptionResult {
    iv: Buffer;           // 12-byte initialization vector (96 bits)
    ciphertext: Buffer;   // Encrypted data
    authTag: Buffer;      // 16-byte authentication tag (128 bits)
}

/**
 * Encrypt plaintext using AES-256-GCM
 * 
 * @param plaintext - Data to encrypt (will be converted to UTF-8)
 * @param key - 32-byte encryption key (from key derivation)
 * @returns Encryption result with IV, ciphertext, and auth tag
 */
export function encrypt(plaintext: string, key: Buffer): EncryptionResult {
    if (!plaintext) {
        throw new Error('Plaintext is required for encryption');
    }

    if (!key || key.length !== 32) {
        throw new Error('Key must be 32 bytes (256 bits) for AES-256');
    }

    // Generate random IV (initialization vector)
    // 96 bits (12 bytes) is optimal for GCM mode
    const iv = crypto.randomBytes(12);

    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    // Encrypt data
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ]);

    // Get authentication tag (proves data wasn't tampered with)
    const authTag = cipher.getAuthTag();

    return {
        iv,
        ciphertext,
        authTag
    };
}

/**
 * Decrypt ciphertext using AES-256-GCM
 * 
 * @param iv - 12-byte initialization vector
 * @param ciphertext - Encrypted data
 * @param authTag - 16-byte authentication tag
 * @param key - 32-byte encryption key (must match encryption key)
 * @returns Decrypted plaintext string
 * @throws Error if authentication fails or decryption fails
 */
export function decrypt(
    iv: Buffer,
    ciphertext: Buffer,
    authTag: Buffer,
    key: Buffer
): string {
    if (!iv || iv.length !== 12) {
        throw new Error('IV must be 12 bytes (96 bits)');
    }

    if (!authTag || authTag.length !== 16) {
        throw new Error('Auth tag must be 16 bytes (128 bits)');
    }

    if (!key || key.length !== 32) {
        throw new Error('Key must be 32 bytes (256 bits) for AES-256');
    }

    if (!ciphertext || ciphertext.length === 0) {
        throw new Error('Ciphertext is required for decryption');
    }

    try {
        // Create decipher
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

        // Set authentication tag (GCM will verify this)
        decipher.setAuthTag(authTag);

        // Decrypt data
        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);

        return plaintext.toString('utf8');
    } catch (error) {
        // Authentication failure or decryption error
        throw new Error(
            'Decryption failed - authentication tag verification failed or invalid key. ' +
            'This may indicate tampering or using the wrong JWT token.'
        );
    }
}
