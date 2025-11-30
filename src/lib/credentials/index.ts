/**
 * Credentials Management
 *
 * Utilities for password hashing, API key generation, and SSH key management.
 */

export { hashPassword, verifyPassword, needsRehash } from './password.js';
export {
    generateApiKey,
    hashApiKey,
    parseApiKey,
    isValidApiKeyFormat,
    verifyApiKey,
    type ApiKeyEnvironment,
    type GeneratedApiKey,
    type ParsedApiKey,
} from './api-key.js';
export {
    parseSSHPublicKey,
    calculateFingerprint,
    keysEqual,
    isValidSSHPublicKey,
    formatKeyForDisplay,
    type SSHKeyAlgorithm,
    type ParsedSSHKey,
} from './ssh-key.js';
export {
    listKeys,
    addSSHKey,
    addApiKey,
    removeKey,
    findSSHKeyByFingerprint,
    touchKey,
    type KeyType,
    type KeyRecord,
    type AddSSHKeyOptions,
    type AddApiKeyOptions,
    type AddApiKeyResult,
} from './keys.js';
