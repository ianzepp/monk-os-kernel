/**
 * SSH Key Utilities
 *
 * Parse and fingerprint SSH public keys for credential storage.
 */

import { createHash } from 'crypto';

/**
 * Supported SSH key algorithms
 */
export type SSHKeyAlgorithm = 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' | 'ecdsa-sha2-nistp521';

/**
 * Parsed SSH public key
 */
export interface ParsedSSHKey {
    algorithm: SSHKeyAlgorithm;
    data: Buffer;           // Raw key data (base64 decoded)
    comment?: string;       // Optional comment (e.g., user@host)
    fingerprint: string;    // SHA256 fingerprint
    original: string;       // Original key string
}

/**
 * Valid algorithm prefixes
 */
const VALID_ALGORITHMS: SSHKeyAlgorithm[] = [
    'ssh-rsa',
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
];

/**
 * Parse an SSH public key string
 *
 * Accepts formats:
 * - "ssh-ed25519 AAAA... comment"
 * - "ssh-rsa AAAA... user@host"
 *
 * @param keyString - The public key string
 * @returns Parsed key or null if invalid
 */
export function parseSSHPublicKey(keyString: string): ParsedSSHKey | null {
    const trimmed = keyString.trim();
    const parts = trimmed.split(/\s+/);

    if (parts.length < 2) {
        return null;
    }

    const algorithm = parts[0] as SSHKeyAlgorithm;
    const base64Data = parts[1];
    const comment = parts.slice(2).join(' ') || undefined;

    // Validate algorithm
    if (!VALID_ALGORITHMS.includes(algorithm)) {
        return null;
    }

    // Decode base64 data
    let data: Buffer;
    try {
        data = Buffer.from(base64Data, 'base64');
    } catch {
        return null;
    }

    // Validate that decoded data starts with algorithm name
    // SSH key format: [4-byte length][algorithm name][key data...]
    try {
        const algoLen = data.readUInt32BE(0);
        const algoName = data.subarray(4, 4 + algoLen).toString('utf8');
        if (algoName !== algorithm) {
            return null;
        }
    } catch {
        return null;
    }

    // Calculate fingerprint
    const fingerprint = calculateFingerprint(data);

    return {
        algorithm,
        data,
        comment,
        fingerprint,
        original: trimmed,
    };
}

/**
 * Calculate SHA256 fingerprint of key data
 *
 * @param data - Raw key data buffer
 * @returns Fingerprint in "SHA256:base64" format
 */
export function calculateFingerprint(data: Buffer): string {
    const hash = createHash('sha256').update(data).digest('base64');
    // Remove trailing = padding to match ssh-keygen output
    const trimmed = hash.replace(/=+$/, '');
    return `SHA256:${trimmed}`;
}

/**
 * Compare two SSH public keys for equality
 *
 * @param key1 - First key (parsed or string)
 * @param key2 - Second key (parsed or string)
 * @returns True if keys are identical
 */
export function keysEqual(
    key1: ParsedSSHKey | string,
    key2: ParsedSSHKey | string
): boolean {
    const parsed1 = typeof key1 === 'string' ? parseSSHPublicKey(key1) : key1;
    const parsed2 = typeof key2 === 'string' ? parseSSHPublicKey(key2) : key2;

    if (!parsed1 || !parsed2) {
        return false;
    }

    return parsed1.fingerprint === parsed2.fingerprint;
}

/**
 * Validate that a string is a valid SSH public key
 *
 * @param keyString - The key string to validate
 * @returns True if valid
 */
export function isValidSSHPublicKey(keyString: string): boolean {
    return parseSSHPublicKey(keyString) !== null;
}

/**
 * Format a key for display (truncated)
 *
 * @param key - Parsed key or string
 * @returns Short display format
 */
export function formatKeyForDisplay(key: ParsedSSHKey | string): string {
    const parsed = typeof key === 'string' ? parseSSHPublicKey(key) : key;
    if (!parsed) {
        return '(invalid key)';
    }

    const comment = parsed.comment ? ` (${parsed.comment})` : '';
    return `${parsed.algorithm} ${parsed.fingerprint}${comment}`;
}
