/**
 * Generic Key/Credential Management
 *
 * CRUD operations for credentials table, supporting multiple key types:
 * - ssh_pubkey: SSH public keys for shell authentication
 * - api_key: API keys for HTTP authentication
 * - password: User passwords (handled separately by password.ts)
 */

import { randomUUID } from 'crypto';
import type { System } from '@src/lib/system.js';
import { parseSSHPublicKey, type ParsedSSHKey } from './ssh-key.js';
import { generateApiKey, type GeneratedApiKey, type ApiKeyEnvironment } from './api-key.js';

/**
 * Supported key types
 */
export type KeyType = 'ssh_pubkey' | 'api_key';

/**
 * Key record from credentials table
 */
export interface KeyRecord {
    id: string;
    user_id: string;
    type: KeyType;
    identifier: string;     // Fingerprint for SSH, prefix for API
    name: string | null;
    algorithm: string | null;
    created_at: Date;
    expires_at: Date | null;
    last_used_at: Date | null;
}

/**
 * Options for adding an SSH key
 */
export interface AddSSHKeyOptions {
    publicKey: string;
    name?: string;
}

/**
 * Options for adding an API key
 */
export interface AddApiKeyOptions {
    name?: string;
    environment?: ApiKeyEnvironment;
    expiresAt?: Date;
}

/**
 * Result of adding an API key (includes the secret, shown only once)
 */
export interface AddApiKeyResult extends KeyRecord {
    secret: string;  // Full API key - only returned on creation
}

/**
 * List keys for a user
 */
export async function listKeys(
    system: System,
    userId: string,
    type?: KeyType
): Promise<KeyRecord[]> {
    const whereClause = type
        ? `user_id = $1 AND type = $2 AND deleted_at IS NULL`
        : `user_id = $1 AND type != 'password' AND deleted_at IS NULL`;

    const params = type ? [userId, type] : [userId];

    const result = await system.database.execute(
        `SELECT id, user_id, type, identifier, name, algorithm, created_at, expires_at, last_used_at
         FROM credentials
         WHERE ${whereClause}
         ORDER BY created_at ASC`,
        params
    );

    return (result.rows || []).map((row: any) => ({
        ...row,
        created_at: row.created_at ? new Date(row.created_at) : new Date(),
        expires_at: row.expires_at ? new Date(row.expires_at) : null,
        last_used_at: row.last_used_at ? new Date(row.last_used_at) : null,
    }));
}

/**
 * Add an SSH public key
 */
export async function addSSHKey(
    system: System,
    userId: string,
    options: AddSSHKeyOptions
): Promise<KeyRecord> {
    const parsed = parseSSHPublicKey(options.publicKey);
    if (!parsed) {
        throw new Error('Invalid SSH public key');
    }

    // Check for duplicate
    const existing = await system.database.execute(
        `SELECT id FROM credentials
         WHERE user_id = $1 AND type = 'ssh_pubkey' AND identifier = $2 AND deleted_at IS NULL`,
        [userId, parsed.fingerprint]
    );

    if (existing.rows && existing.rows.length > 0) {
        throw new Error('SSH key already registered');
    }

    const id = randomUUID();
    const name = options.name || parsed.comment || null;

    await system.database.execute(
        `INSERT INTO credentials (id, user_id, type, identifier, secret, algorithm, name, created_at, updated_at)
         VALUES ($1, $2, 'ssh_pubkey', $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, userId, parsed.fingerprint, parsed.original, parsed.algorithm, name]
    );

    return {
        id,
        user_id: userId,
        type: 'ssh_pubkey',
        identifier: parsed.fingerprint,
        name,
        algorithm: parsed.algorithm,
        created_at: new Date(),
        expires_at: null,
        last_used_at: null,
    };
}

/**
 * Add an API key
 */
export async function addApiKey(
    system: System,
    userId: string,
    options: AddApiKeyOptions = {}
): Promise<AddApiKeyResult> {
    const environment = options.environment || 'live';
    const generated = generateApiKey(environment);

    const id = randomUUID();

    await system.database.execute(
        `INSERT INTO credentials (id, user_id, type, identifier, secret, algorithm, name, expires_at, created_at, updated_at)
         VALUES ($1, $2, 'api_key', $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, userId, generated.prefix, generated.hash, generated.algorithm, options.name || null, options.expiresAt || null]
    );

    return {
        id,
        user_id: userId,
        type: 'api_key',
        identifier: generated.prefix,
        name: options.name || null,
        algorithm: generated.algorithm,
        created_at: new Date(),
        expires_at: options.expiresAt || null,
        last_used_at: null,
        secret: generated.key,  // Full key - only shown once
    };
}

/**
 * Remove a key by identifier (fingerprint/prefix) or ID
 */
export async function removeKey(
    system: System,
    userId: string,
    identifier: string
): Promise<KeyRecord | null> {
    // Try to find by identifier first, then by ID
    let result = await system.database.execute(
        `SELECT id, user_id, type, identifier, name, algorithm, created_at, expires_at, last_used_at
         FROM credentials
         WHERE user_id = $1 AND identifier = $2 AND type != 'password' AND deleted_at IS NULL`,
        [userId, identifier]
    );

    if (!result.rows || result.rows.length === 0) {
        // Try by ID
        result = await system.database.execute(
            `SELECT id, user_id, type, identifier, name, algorithm, created_at, expires_at, last_used_at
             FROM credentials
             WHERE user_id = $1 AND id = $2 AND type != 'password' AND deleted_at IS NULL`,
            [userId, identifier]
        );
    }

    if (!result.rows || result.rows.length === 0) {
        return null;
    }

    const key = result.rows[0];

    // Soft delete
    await system.database.execute(
        `UPDATE credentials SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [key.id]
    );

    return {
        ...key,
        created_at: key.created_at ? new Date(key.created_at) : new Date(),
        expires_at: key.expires_at ? new Date(key.expires_at) : null,
        last_used_at: key.last_used_at ? new Date(key.last_used_at) : null,
    };
}

/**
 * Find an SSH key by its public key data (for authentication)
 */
export async function findSSHKeyByFingerprint(
    system: System,
    userId: string,
    fingerprint: string
): Promise<KeyRecord | null> {
    const result = await system.database.execute(
        `SELECT id, user_id, type, identifier, name, algorithm, created_at, expires_at, last_used_at
         FROM credentials
         WHERE user_id = $1 AND type = 'ssh_pubkey' AND identifier = $2 AND deleted_at IS NULL`,
        [userId, fingerprint]
    );

    if (!result.rows || result.rows.length === 0) {
        return null;
    }

    const key = result.rows[0];
    return {
        ...key,
        created_at: key.created_at ? new Date(key.created_at) : new Date(),
        expires_at: key.expires_at ? new Date(key.expires_at) : null,
        last_used_at: key.last_used_at ? new Date(key.last_used_at) : null,
    };
}

/**
 * Update last_used_at timestamp for a key
 */
export async function touchKey(
    system: System,
    keyId: string
): Promise<void> {
    await system.database.execute(
        `UPDATE credentials SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [keyId]
    );
}
