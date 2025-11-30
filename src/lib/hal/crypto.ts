/**
 * Crypto Device
 *
 * Cryptographic operations: hashing, encryption, key derivation.
 *
 * Bun touchpoints:
 * - Bun.hash() for fast hashing (non-standard)
 * - Bun.CryptoHasher for streaming hashes
 * - crypto.subtle for Web Crypto API (standard)
 * - Bun.password for password hashing (argon2, bcrypt)
 *
 * Caveats:
 * - Bun.hash() uses xxhash by default (fast but not cryptographic!)
 * - For cryptographic hashes, use crypto.subtle or Bun.CryptoHasher
 * - Web Crypto API is async; Bun.hash() is sync
 * - Key import/export requires specific formats (raw, pkcs8, spki, jwk)
 * - AES-GCM includes auth tag in ciphertext; AES-CBC does not
 *
 * CryptoKey Lifetime and Export:
 * - CryptoKey objects are opaque handles to key material
 * - Keys exist only in memory; no automatic persistence
 * - Keys are NOT serializable via JSON.stringify()
 * - To persist keys, use crypto.subtle.exportKey():
 *   - 'raw': Export as Uint8Array (symmetric keys only)
 *   - 'jwk': Export as JSON Web Key (all key types)
 *   - 'pkcs8': Export private keys in PKCS#8 format
 *   - 'spki': Export public keys in SubjectPublicKeyInfo format
 * - Keys generated with extractable=false cannot be exported
 * - genkey() creates keys with extractable=true for flexibility
 * - To reimport: use crypto.subtle.importKey() with same format
 * - Keys do not survive process restart; must export before shutdown
 */

/**
 * Hash algorithm identifiers
 */
export type HashAlg = 'sha256' | 'sha384' | 'sha512' | 'sha1' | 'md5' | 'blake2b256';

/**
 * Cipher algorithm identifiers
 */
export type CipherAlg = 'aes-256-gcm' | 'aes-256-cbc' | 'aes-128-gcm';

/**
 * Key algorithm identifiers
 */
export type KeyAlg = 'aes-256' | 'aes-128' | 'hmac-sha256';

/**
 * Key derivation function identifiers
 */
export type KdfAlg = 'pbkdf2-sha256' | 'argon2id';

/**
 * Crypto device interface.
 */
export interface CryptoDevice {
    /**
     * Compute hash of data.
     *
     * Bun: Uses Bun.CryptoHasher for streaming or crypto.subtle
     *
     * @param alg - Hash algorithm
     * @param data - Data to hash
     * @returns Hash digest
     */
    hash(alg: HashAlg, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Compute HMAC of data.
     *
     * Bun: crypto.subtle.sign() with HMAC
     *
     * @param alg - Hash algorithm for HMAC
     * @param key - HMAC key
     * @param data - Data to authenticate
     * @returns HMAC digest
     */
    hmac(alg: HashAlg, key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Encrypt data.
     *
     * Bun: crypto.subtle.encrypt()
     *
     * Caveat: For AES-GCM, generates random IV and prepends to ciphertext.
     * For AES-CBC, generates random IV and prepends; no auth tag.
     *
     * @param alg - Cipher algorithm
     * @param key - Encryption key
     * @param data - Plaintext
     * @returns Ciphertext (IV prepended)
     */
    encrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Decrypt data.
     *
     * Bun: crypto.subtle.decrypt()
     *
     * Caveat: Expects IV prepended to ciphertext (as produced by encrypt).
     *
     * @param alg - Cipher algorithm
     * @param key - Decryption key
     * @param data - Ciphertext (IV prepended)
     * @returns Plaintext
     */
    decrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Generate a cryptographic key.
     *
     * Bun: crypto.subtle.generateKey()
     *
     * Lifetime: Keys exist only in memory. To persist:
     * ```typescript
     * const key = await crypto.genkey('aes-256');
     * const raw = await crypto.subtle.exportKey('raw', key);
     * // Store raw bytes, reimport with importKey()
     * ```
     *
     * @param alg - Key algorithm
     * @returns Generated key (extractable=true)
     */
    genkey(alg: KeyAlg): Promise<CryptoKey>;

    /**
     * Derive key from password.
     *
     * Bun: Bun.password.hash() for argon2, crypto.subtle for PBKDF2
     *
     * Caveat: For argon2id, returns the full hash output (includes salt).
     * For PBKDF2, salt must be provided and result is raw key bytes.
     *
     * @param alg - KDF algorithm
     * @param password - Password bytes
     * @param salt - Salt bytes (ignored for argon2 which generates its own)
     * @returns Derived key bytes
     */
    derive(alg: KdfAlg, password: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;

    /**
     * Verify password against hash.
     *
     * Bun: Bun.password.verify() for argon2
     *
     * Only applicable for password hashing algorithms (argon2id).
     *
     * @param hash - Previously derived hash
     * @param password - Password to verify
     * @returns True if password matches
     */
    verify(hash: Uint8Array, password: Uint8Array): Promise<boolean>;
}

/**
 * Bun crypto device implementation
 *
 * Bun touchpoints:
 * - Bun.CryptoHasher for hashing
 * - crypto.subtle for HMAC, encrypt, decrypt, generateKey
 * - Bun.password for argon2id
 *
 * Caveats:
 * - Mixed sync (Bun.CryptoHasher) and async (subtle) APIs
 * - AES-GCM IV is 12 bytes, AES-CBC IV is 16 bytes
 * - argon2id not available in pure Web Crypto; uses Bun extension
 */
export class BunCryptoDevice implements CryptoDevice {
    async hash(alg: HashAlg, data: Uint8Array): Promise<Uint8Array> {
        // Map algorithm names
        const algMap: Record<HashAlg, string> = {
            sha256: 'sha256',
            sha384: 'sha384',
            sha512: 'sha512',
            sha1: 'sha1',
            md5: 'md5',
            blake2b256: 'blake2b256',
        };

        const hasher = new Bun.CryptoHasher(algMap[alg] as any);
        hasher.update(data);
        const result = hasher.digest();

        // Bun returns Buffer, convert to Uint8Array
        return new Uint8Array(result);
    }

    async hmac(alg: HashAlg, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
        const algMap: Record<HashAlg, string> = {
            sha256: 'SHA-256',
            sha384: 'SHA-384',
            sha512: 'SHA-512',
            sha1: 'SHA-1',
            md5: 'MD5', // Note: MD5 HMAC may not be supported
            blake2b256: 'BLAKE2B-256', // May not be supported in subtle
        };

        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            key,
            { name: 'HMAC', hash: algMap[alg] },
            false,
            ['sign']
        );

        const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
        return new Uint8Array(signature);
    }

    async encrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
        const ivLength = alg.includes('gcm') ? 12 : 16;
        const iv = crypto.getRandomValues(new Uint8Array(ivLength));

        const algSpec = this.getCipherAlgSpec(alg, iv);
        const ciphertext = await crypto.subtle.encrypt(algSpec, key, data);

        // Prepend IV to ciphertext
        const result = new Uint8Array(iv.length + ciphertext.byteLength);
        result.set(iv);
        result.set(new Uint8Array(ciphertext), iv.length);
        return result;
    }

    async decrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
        const ivLength = alg.includes('gcm') ? 12 : 16;
        const iv = data.slice(0, ivLength);
        const ciphertext = data.slice(ivLength);

        const algSpec = this.getCipherAlgSpec(alg, iv);
        const plaintext = await crypto.subtle.decrypt(algSpec, key, ciphertext);
        return new Uint8Array(plaintext);
    }

    private getCipherAlgSpec(alg: CipherAlg, iv: Uint8Array): AesGcmParams | AesCbcParams {
        switch (alg) {
            case 'aes-256-gcm':
            case 'aes-128-gcm':
                return { name: 'AES-GCM', iv };
            case 'aes-256-cbc':
                return { name: 'AES-CBC', iv };
            default:
                throw new Error(`Unsupported cipher: ${alg}`);
        }
    }

    async genkey(alg: KeyAlg): Promise<CryptoKey> {
        switch (alg) {
            case 'aes-256':
                return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
                    'encrypt',
                    'decrypt',
                ]);
            case 'aes-128':
                return crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, [
                    'encrypt',
                    'decrypt',
                ]);
            case 'hmac-sha256':
                return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, [
                    'sign',
                    'verify',
                ]);
            default:
                throw new Error(`Unsupported key algorithm: ${alg}`);
        }
    }

    async derive(alg: KdfAlg, password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
        switch (alg) {
            case 'pbkdf2-sha256': {
                const keyMaterial = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, [
                    'deriveBits',
                ]);

                const bits = await crypto.subtle.deriveBits(
                    {
                        name: 'PBKDF2',
                        salt,
                        iterations: 100000,
                        hash: 'SHA-256',
                    },
                    keyMaterial,
                    256
                );

                return new Uint8Array(bits);
            }

            case 'argon2id': {
                // Bun.password.hash returns a string containing the hash
                const passwordStr = new TextDecoder().decode(password);
                const hashStr = await Bun.password.hash(passwordStr, {
                    algorithm: 'argon2id',
                    memoryCost: 65536, // 64 MB
                    timeCost: 3,
                });
                return new TextEncoder().encode(hashStr);
            }

            default:
                throw new Error(`Unsupported KDF: ${alg}`);
        }
    }

    async verify(hash: Uint8Array, password: Uint8Array): Promise<boolean> {
        const hashStr = new TextDecoder().decode(hash);
        const passwordStr = new TextDecoder().decode(password);

        return Bun.password.verify(passwordStr, hashStr);
    }
}
