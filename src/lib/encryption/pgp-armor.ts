/**
 * PGP ASCII Armor Encoding/Decoding
 *
 * Encodes binary encrypted data in ASCII armor format.
 * Similar to PGP/GPG ASCII armor but with custom headers for Monk API.
 * 
 * Format:
 * -----BEGIN MONK ENCRYPTED MESSAGE-----
 * Version: Monk-API/3.0
 * Cipher: AES-256-GCM
 * 
 * <base64-encoded data in 64-character lines>
 * -----END MONK ENCRYPTED MESSAGE-----
 * 
 * The base64 data contains: IV (12 bytes) + ciphertext + authTag (16 bytes)
 */

import type { EncryptionResult } from './aes-gcm.js';

/**
 * Result of parsing ASCII armor
 */
export interface ArmorParseResult {
    iv: Buffer;           // 12-byte IV
    ciphertext: Buffer;   // Encrypted data
    authTag: Buffer;      // 16-byte auth tag
    version?: string;     // Version header value
    cipher?: string;      // Cipher header value
}

/**
 * Create PGP-style ASCII armor from encryption result
 * 
 * @param result - Encryption result with IV, ciphertext, and auth tag
 * @returns ASCII armored message
 */
export function createArmor(result: EncryptionResult): string {
    const { iv, ciphertext, authTag } = result;

    // Concatenate: IV + ciphertext + authTag
    // This is what gets base64-encoded
    const combined = Buffer.concat([iv, ciphertext, authTag]);

    // Base64 encode
    const base64 = combined.toString('base64');

    // Break into 64-character lines (PGP convention)
    const lines = base64.match(/.{1,64}/g) || [];

    // Build ASCII armor message
    const armor = [
        '-----BEGIN MONK ENCRYPTED MESSAGE-----',
        'Version: Monk-API/3.0',
        'Cipher: AES-256-GCM',
        '',  // Blank line separates headers from data
        ...lines,
        '-----END MONK ENCRYPTED MESSAGE-----'
    ].join('\n');

    return armor;
}

/**
 * Parse PGP-style ASCII armor to extract encrypted components
 * 
 * @param armored - ASCII armored message
 * @returns Parsed components (IV, ciphertext, auth tag)
 * @throws Error if armor format is invalid
 */
export function parseArmor(armored: string): ArmorParseResult {
    if (!armored || armored.trim().length === 0) {
        throw new Error('Armored message is empty');
    }

    const lines = armored.split('\n').map(l => l.trim());

    // Find begin/end markers
    const beginIndex = lines.findIndex(l => l.startsWith('-----BEGIN MONK ENCRYPTED MESSAGE-----'));
    const endIndex = lines.findIndex(l => l.startsWith('-----END MONK ENCRYPTED MESSAGE-----'));

    if (beginIndex === -1) {
        throw new Error('Invalid armor: missing BEGIN marker');
    }

    if (endIndex === -1) {
        throw new Error('Invalid armor: missing END marker');
    }

    if (endIndex <= beginIndex) {
        throw new Error('Invalid armor: END marker before BEGIN marker');
    }

    // Extract headers (between BEGIN and blank line)
    const headers: Record<string, string> = {};
    let dataStartIndex = beginIndex + 1;

    for (let i = beginIndex + 1; i < endIndex; i++) {
        const line = lines[i];

        // Blank line marks end of headers
        if (line === '') {
            dataStartIndex = i + 1;
            break;
        }

        // Parse header: "Key: Value"
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();
            headers[key] = value;
        }
    }

    // Extract base64 data (between headers and END marker)
    const dataLines = lines.slice(dataStartIndex, endIndex);
    const base64 = dataLines.join('');

    if (!base64 || base64.length === 0) {
        throw new Error('Invalid armor: no base64 data found');
    }

    // Decode base64
    let combined: Buffer;
    try {
        combined = Buffer.from(base64, 'base64');
    } catch (error) {
        throw new Error('Invalid armor: base64 decoding failed');
    }

    // Extract components: IV (12) + ciphertext + authTag (16)
    if (combined.length < 28) {  // Minimum: 12 + 0 + 16
        throw new Error('Invalid armor: data too short (minimum 28 bytes)');
    }

    const iv = combined.slice(0, 12);
    const authTag = combined.slice(-16);
    const ciphertext = combined.slice(12, -16);

    return {
        iv,
        ciphertext,
        authTag,
        version: headers['Version'],
        cipher: headers['Cipher']
    };
}

/**
 * Validate that ASCII armor has correct format
 * 
 * @param armored - ASCII armored message
 * @returns true if valid, false otherwise
 */
export function isValidArmor(armored: string): boolean {
    try {
        parseArmor(armored);
        return true;
    } catch {
        return false;
    }
}
