/**
 * Crypto Device - Cryptographic operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Crypto Device provides cryptographic primitives for Monk OS: hashing,
 * encryption, decryption, key generation, and password derivation. This layer
 * abstracts the underlying Web Crypto API and Bun-specific extensions behind
 * a consistent interface.
 *
 * Design philosophy:
 * 1. Strong defaults: AES-256-GCM for encryption, SHA-256 for hashing, argon2id
 *    for password hashing
 * 2. Extractable keys: Keys are generated with extractable=true to allow
 *    serialization and persistence (keys don't survive process restart otherwise)
 * 3. IV prepending: For symmetric encryption, IV is prepended to ciphertext
 *    automatically (caller doesn't manage IV separately)
 * 4. Algorithm agility: Support multiple algorithms via string discriminators
 *
 * The crypto device serves multiple use cases:
 * - VFS: Encrypt files, compute checksums, verify integrity
 * - Authentication: Hash passwords, derive session keys, verify credentials
 * - IPC: Sign messages, encrypt channels, authenticate peers
 * - Storage: Encrypt blocks, derive encryption keys from passwords
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All hash outputs are deterministic (same input -> same output)
 * INV-2: All keys generated with extractable=true (can be exported)
 * INV-3: All symmetric encryption prepends IV to ciphertext
 * INV-4: All symmetric decryption expects IV prepended to ciphertext
 * INV-5: IV length is 12 bytes for GCM, 16 bytes for CBC
 * INV-6: All operations accept Uint8Array (not ArrayBuffer or Buffer)
 * INV-7: CryptoKey objects are opaque (no direct key material access)
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. All
 * crypto operations are async (even if Bun provides sync alternatives).
 *
 * Concurrency properties:
 * - All operations are pure (no shared mutable state)
 * - CryptoKey objects are opaque and immutable after creation
 * - No global state (except Web Crypto API which is thread-safe)
 * - Multiple concurrent encrypt/decrypt/hash calls are safe
 * - Random number generation (crypto.getRandomValues) is thread-safe
 *
 * Keys are NOT automatically persisted. Caller must export keys and store
 * them explicitly. Keys do not survive process restart.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: All operations are stateless (no race conditions on device state)
 * RC-2: CryptoKey objects are immutable (safe to share across operations)
 * RC-3: Random IV generation uses crypto.getRandomValues (thread-safe CSPRNG)
 * RC-4: No file I/O in this layer (no TOCTOU bugs)
 *
 * MEMORY MANAGEMENT
 * =================
 * Input/output buffers:
 * - Caller allocates input Uint8Array, device allocates output Uint8Array
 * - Device returns new buffers (not views into shared memory)
 * - Caller owns lifetime of returned buffers
 *
 * CryptoKey objects:
 * - Allocated by crypto.subtle.generateKey() or importKey()
 * - Opaque handles (key material not directly accessible)
 * - Garbage collected when no references remain
 * - To persist, must export via crypto.subtle.exportKey() before GC
 *
 * Key lifetime:
 * - Keys exist only in memory
 * - Keys do NOT automatically persist
 * - To persist: exportKey() -> store bytes -> importKey() on restart
 * - Extractable keys can be exported; non-extractable cannot
 * - This device generates extractable keys by default for flexibility
 *
 * TESTABILITY
 * ===========
 * - All operations are pure functions (deterministic for given inputs)
 * - Hash operations are deterministic (same input -> same output)
 * - Encryption is non-deterministic (random IV) but verify via decrypt
 * - Password hashing includes random salt (argon2id) but verify via verify()
 * - No mocking needed; Web Crypto API is standard and testable
 * - Can test with known test vectors (NIST, RFC test cases)
 *
 * @module hal/crypto
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Hash algorithm identifiers.
 *
 * WHY: Provides algorithm agility. Callers can choose hash based on security/
 * performance tradeoff.
 *
 * ALGORITHMS:
 * - sha256: Most common, good security (256-bit output)
 * - sha384: Stronger than sha256, slower (384-bit output)
 * - sha512: Strongest, slowest (512-bit output)
 * - sha1: Legacy, broken, avoid for security (160-bit output)
 * - md5: Legacy, broken, avoid for security (128-bit output)
 * - blake2b256: Fast, secure alternative to SHA-256 (256-bit output)
 */
export type HashAlg = 'sha256' | 'sha384' | 'sha512' | 'sha1' | 'md5' | 'blake2b256';

/**
 * Cipher algorithm identifiers.
 *
 * WHY: Provides algorithm agility for symmetric encryption. Callers can choose
 * based on security requirements and performance.
 *
 * ALGORITHMS:
 * - aes-256-gcm: Authenticated encryption, 256-bit key (recommended)
 * - aes-128-gcm: Authenticated encryption, 128-bit key (faster)
 * - aes-256-cbc: Traditional block cipher, 256-bit key (no authentication!)
 *
 * NOTE: GCM modes include authentication tag in ciphertext (detect tampering).
 * CBC mode does NOT include authentication (caller must add HMAC separately).
 */
export type CipherAlg = 'aes-256-gcm' | 'aes-256-cbc' | 'aes-128-gcm';

/**
 * Key algorithm identifiers.
 *
 * WHY: Specifies key type for generation. Different algorithms have different
 * key lengths and usage patterns.
 *
 * ALGORITHMS:
 * - aes-256: 256-bit AES key (for encryption/decryption)
 * - aes-128: 128-bit AES key (for encryption/decryption)
 * - hmac-sha256: HMAC key with SHA-256 (for message authentication)
 */
export type KeyAlg = 'aes-256' | 'aes-128' | 'hmac-sha256';

/**
 * Key derivation function identifiers.
 *
 * WHY: Derives keys from passwords. Different KDFs have different security/
 * performance tradeoffs.
 *
 * ALGORITHMS:
 * - pbkdf2-sha256: Standard KDF, configurable iterations (100k iterations)
 * - argon2id: Modern KDF, memory-hard, resistant to GPU attacks (recommended)
 *
 * NOTE: argon2id is only available in Bun (not standard Web Crypto).
 */
export type KdfAlg = 'pbkdf2-sha256' | 'argon2id';

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Crypto device interface.
 *
 * WHY: Provides cryptographic primitives for the kernel. All operations are
 * async (even if underlying implementation is sync) for consistency.
 *
 * INVARIANTS:
 * - All hash outputs are deterministic
 * - All encryption prepends IV to ciphertext
 * - All keys are extractable (can be exported)
 * - All operations accept Uint8Array (not Buffer or ArrayBuffer)
 */
export interface CryptoDevice {
    /**
     * Compute hash of data.
     *
     * WHY: Fundamental hash primitive. Used for checksums, content addressing,
     * integrity verification.
     *
     * ALGORITHM:
     * 1. Initialize hasher with algorithm
     * 2. Update hasher with data
     * 3. Finalize and return digest
     *
     * INVARIANT: Deterministic (same input -> same output).
     *
     * @param alg - Hash algorithm (sha256, sha512, etc.)
     * @param data - Data to hash
     * @returns Hash digest (length depends on algorithm)
     */
    hash(alg: HashAlg, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Compute HMAC of data.
     *
     * WHY: Provides message authentication. Unlike plain hash, HMAC requires
     * a secret key, proving that the sender knows the key.
     *
     * ALGORITHM:
     * 1. Import key as HMAC key
     * 2. Sign data with HMAC
     * 3. Return signature (digest)
     *
     * INVARIANT: Deterministic for given key and data.
     *
     * @param alg - Hash algorithm for HMAC (sha256, sha512, etc.)
     * @param key - HMAC secret key (raw bytes)
     * @param data - Data to authenticate
     * @returns HMAC digest (length depends on algorithm)
     */
    hmac(alg: HashAlg, key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Encrypt data.
     *
     * WHY: Provides confidentiality. Only holders of the key can decrypt.
     *
     * ALGORITHM:
     * 1. Generate random IV (12 bytes for GCM, 16 bytes for CBC)
     * 2. Encrypt data with key and IV
     * 3. Prepend IV to ciphertext
     * 4. Return IV + ciphertext
     *
     * RACE CONDITION:
     * IV generation uses crypto.getRandomValues which is thread-safe CSPRNG.
     * No state shared across calls.
     *
     * INVARIANT: IV is always prepended to ciphertext.
     *
     * NOTE: For GCM modes, ciphertext includes authentication tag (last 16 bytes).
     * For CBC mode, no authentication (caller must add HMAC).
     *
     * @param alg - Cipher algorithm (aes-256-gcm, aes-128-gcm, aes-256-cbc)
     * @param key - Encryption key (from genkey())
     * @param data - Plaintext
     * @returns Ciphertext (IV prepended)
     */
    encrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Decrypt data.
     *
     * WHY: Recovers plaintext from ciphertext. Only holders of the key can decrypt.
     *
     * ALGORITHM:
     * 1. Extract IV from ciphertext (first 12 or 16 bytes)
     * 2. Extract ciphertext (remaining bytes)
     * 3. Decrypt with key and IV
     * 4. Return plaintext
     *
     * INVARIANT: Expects IV prepended to ciphertext (as produced by encrypt()).
     *
     * NOTE: For GCM modes, decryption verifies authentication tag. If ciphertext
     * was tampered with, decryption will fail (throw error).
     *
     * @param alg - Cipher algorithm (must match encrypt())
     * @param key - Decryption key (same as encryption key)
     * @param data - Ciphertext (IV prepended)
     * @returns Plaintext
     * @throws Error if authentication fails (GCM) or decryption fails
     */
    decrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array>;

    /**
     * Generate a cryptographic key.
     *
     * WHY: Creates keys for encryption or HMAC. Keys are opaque handles (not
     * raw bytes). Caller must export via crypto.subtle.exportKey() to persist.
     *
     * ALGORITHM:
     * 1. Call crypto.subtle.generateKey() with algorithm spec
     * 2. Return CryptoKey handle (opaque)
     *
     * KEY LIFETIME:
     * - Keys exist only in memory
     * - Keys do NOT automatically persist
     * - To persist:
     *   ```typescript
     *   const key = await crypto.genkey('aes-256');
     *   const raw = await crypto.subtle.exportKey('raw', key);
     *   // Store raw bytes, reimport with importKey()
     *   ```
     * - Keys are generated with extractable=true (can be exported)
     *
     * TESTABILITY: Can verify key properties (algorithm, extractable, usages).
     *
     * @param alg - Key algorithm (aes-256, aes-128, hmac-sha256)
     * @returns Generated key (extractable=true)
     */
    genkey(alg: KeyAlg): Promise<CryptoKey>;

    /**
     * Derive key from password.
     *
     * WHY: Converts human-memorable passwords into cryptographic keys. Slow by
     * design to resist brute-force attacks.
     *
     * ALGORITHM (pbkdf2-sha256):
     * 1. Import password as key material
     * 2. Derive bits using PBKDF2 with salt and iterations (100k)
     * 3. Return derived key bytes
     *
     * ALGORITHM (argon2id):
     * 1. Hash password with argon2id (memory-hard, 64MB memory, 3 iterations)
     * 2. Return hash string (includes salt and parameters)
     *
     * NOTE: For argon2id, output includes salt and parameters (not just key bytes).
     * For PBKDF2, output is raw key bytes (salt must be provided by caller).
     *
     * @param alg - KDF algorithm (pbkdf2-sha256, argon2id)
     * @param password - Password bytes
     * @param salt - Salt bytes (ignored for argon2id which generates its own)
     * @returns Derived key bytes (or hash string for argon2id)
     */
    derive(alg: KdfAlg, password: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;

    /**
     * Verify password against hash.
     *
     * WHY: Checks if a password matches a previously derived hash. Constant-time
     * comparison to prevent timing attacks.
     *
     * ALGORITHM:
     * 1. Extract algorithm and parameters from hash
     * 2. Derive key from password using same parameters
     * 3. Compare derived key with stored hash (constant-time)
     * 4. Return true if match, false otherwise
     *
     * NOTE: Only applicable for password hashing algorithms (argon2id).
     * For PBKDF2, caller must derive and compare manually.
     *
     * @param hash - Previously derived hash (from derive())
     * @param password - Password to verify
     * @returns True if password matches
     */
    verify(hash: Uint8Array, password: Uint8Array): Promise<boolean>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Bun crypto device implementation.
 *
 * WHY: Implements CryptoDevice using Bun's crypto APIs:
 * - Bun.CryptoHasher for hashing (fast, sync API wrapped in async)
 * - crypto.subtle for HMAC, encrypt, decrypt, key generation (Web Crypto standard)
 * - Bun.password for argon2id (Bun-specific extension)
 *
 * ARCHITECTURE:
 * - Hash operations use Bun.CryptoHasher (faster than crypto.subtle)
 * - HMAC uses crypto.subtle.sign() with HMAC algorithm
 * - Encryption/decryption use crypto.subtle with AES-GCM or AES-CBC
 * - Key generation uses crypto.subtle.generateKey() (extractable=true)
 * - PBKDF2 uses crypto.subtle.deriveBits()
 * - argon2id uses Bun.password.hash() and verify()
 *
 * CONCURRENCY:
 * All operations are stateless. No shared mutable state. Safe to call
 * concurrently from multiple callers.
 *
 * LIMITATIONS:
 * - Mixed sync (CryptoHasher) and async (subtle) APIs wrapped in uniform async
 * - AES-GCM IV is 12 bytes, AES-CBC IV is 16 bytes (caller doesn't see this)
 * - argon2id not available in pure Web Crypto (Bun extension)
 * - Some hash algorithms (MD5, BLAKE2B) may not be supported by crypto.subtle
 *
 * TESTABILITY:
 * - Can test with known test vectors (NIST, RFC)
 * - Hash is deterministic (same input -> same output)
 * - Encryption is non-deterministic (random IV) but verify via decrypt
 */
export class BunCryptoDevice implements CryptoDevice {
    // =========================================================================
    // HASH OPERATIONS
    // =========================================================================

    /**
     * Compute hash of data.
     *
     * WHY: Uses Bun.CryptoHasher for fast, synchronous hashing. Wrapped in
     * async for interface consistency.
     *
     * ALGORITHM:
     * 1. Map algorithm name to Bun.CryptoHasher algorithm string
     * 2. Create hasher with algorithm
     * 3. Update hasher with data
     * 4. Finalize and get digest
     * 5. Convert Buffer to Uint8Array (Bun returns Buffer)
     *
     * @param alg - Hash algorithm
     * @param data - Data to hash
     * @returns Hash digest
     */
    async hash(alg: HashAlg, data: Uint8Array): Promise<Uint8Array> {
        // Map algorithm names
        // WHY: Bun.CryptoHasher uses lowercase names
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

        // WHY: Bun returns Buffer, convert to Uint8Array for consistency
        return new Uint8Array(result);
    }

    /**
     * Compute HMAC of data.
     *
     * WHY: Uses crypto.subtle.sign() with HMAC algorithm. Standard Web Crypto API.
     *
     * ALGORITHM:
     * 1. Map algorithm name to Web Crypto hash name (uppercase)
     * 2. Import key as HMAC key with hash algorithm
     * 3. Sign data with HMAC
     * 4. Convert ArrayBuffer to Uint8Array
     *
     * NOTE: Key must be imported (can't use raw bytes directly).
     *
     * @param alg - Hash algorithm for HMAC
     * @param key - HMAC secret key
     * @param data - Data to authenticate
     * @returns HMAC digest
     */
    async hmac(alg: HashAlg, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
        // Map algorithm names
        // WHY: Web Crypto API uses uppercase names (SHA-256, not sha256)
        const algMap: Record<HashAlg, string> = {
            sha256: 'SHA-256',
            sha384: 'SHA-384',
            sha512: 'SHA-512',
            sha1: 'SHA-1',
            md5: 'MD5', // NOTE: MD5 HMAC may not be supported
            blake2b256: 'BLAKE2B-256', // NOTE: May not be supported in subtle
        };

        // Import key as HMAC key
        // WHY: crypto.subtle requires CryptoKey, not raw bytes
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
            { name: 'HMAC', hash: algMap[alg] },
            false,
            ['sign']
        );

        // Sign data with HMAC
        const signature = await crypto.subtle.sign('HMAC', cryptoKey, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
        return new Uint8Array(signature);
    }

    // =========================================================================
    // ENCRYPTION OPERATIONS
    // =========================================================================

    /**
     * Encrypt data.
     *
     * WHY: Uses crypto.subtle.encrypt() with AES-GCM or AES-CBC. Generates
     * random IV and prepends to ciphertext.
     *
     * ALGORITHM:
     * 1. Determine IV length (12 bytes for GCM, 16 bytes for CBC)
     * 2. Generate random IV (crypto.getRandomValues)
     * 3. Create algorithm spec (name, IV)
     * 4. Encrypt data with key and algorithm spec
     * 5. Prepend IV to ciphertext
     * 6. Return IV + ciphertext
     *
     * RACE CONDITION:
     * crypto.getRandomValues is thread-safe CSPRNG. No shared state.
     *
     * @param alg - Cipher algorithm
     * @param key - Encryption key
     * @param data - Plaintext
     * @returns Ciphertext (IV prepended)
     */
    async encrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
        // Determine IV length based on algorithm
        // WHY: GCM uses 12-byte IV (96 bits), CBC uses 16-byte IV (128 bits)
        const ivLength = alg.includes('gcm') ? 12 : 16;
        const iv = crypto.getRandomValues(new Uint8Array(ivLength));

        // Create algorithm spec
        const algSpec = this.getCipherAlgSpec(alg, iv);

        // Encrypt data
        const ciphertext = await crypto.subtle.encrypt(algSpec, key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);

        // Prepend IV to ciphertext
        // WHY: Decryption needs IV, so we bundle it with ciphertext
        const result = new Uint8Array(iv.length + ciphertext.byteLength);
        result.set(iv);
        result.set(new Uint8Array(ciphertext), iv.length);
        return result;
    }

    /**
     * Decrypt data.
     *
     * WHY: Uses crypto.subtle.decrypt() with AES-GCM or AES-CBC. Extracts
     * IV from ciphertext before decrypting.
     *
     * ALGORITHM:
     * 1. Determine IV length (12 bytes for GCM, 16 bytes for CBC)
     * 2. Extract IV from ciphertext (first N bytes)
     * 3. Extract ciphertext (remaining bytes)
     * 4. Create algorithm spec (name, IV)
     * 5. Decrypt ciphertext with key and algorithm spec
     * 6. Return plaintext
     *
     * NOTE: For GCM, decryption verifies authentication tag. If ciphertext
     * was tampered, decrypt() will throw an error.
     *
     * @param alg - Cipher algorithm
     * @param key - Decryption key
     * @param data - Ciphertext (IV prepended)
     * @returns Plaintext
     * @throws Error if authentication fails (GCM) or decryption fails
     */
    async decrypt(alg: CipherAlg, key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
        // Determine IV length based on algorithm
        const ivLength = alg.includes('gcm') ? 12 : 16;

        // Extract IV and ciphertext
        const iv = data.slice(0, ivLength);
        const ciphertext = data.slice(ivLength);

        // Create algorithm spec
        const algSpec = this.getCipherAlgSpec(alg, iv);

        // Decrypt data
        const plaintext = await crypto.subtle.decrypt(algSpec, key, ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer);
        return new Uint8Array(plaintext);
    }

    /**
     * Get cipher algorithm spec for Web Crypto API.
     *
     * WHY: Converts our algorithm names to Web Crypto algorithm objects.
     *
     * @param alg - Cipher algorithm
     * @param iv - Initialization vector
     * @returns Algorithm spec for crypto.subtle
     */
    private getCipherAlgSpec(alg: CipherAlg, iv: Uint8Array): { name: string; iv: Uint8Array } {
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

    // =========================================================================
    // KEY OPERATIONS
    // =========================================================================

    /**
     * Generate a cryptographic key.
     *
     * WHY: Uses crypto.subtle.generateKey() to create keys. Keys are generated
     * with extractable=true so they can be exported and persisted.
     *
     * ALGORITHM:
     * 1. Map algorithm name to Web Crypto algorithm spec
     * 2. Call crypto.subtle.generateKey() with spec
     * 3. Return CryptoKey handle (opaque)
     *
     * KEY PROPERTIES:
     * - extractable=true (can be exported)
     * - usages: ['encrypt', 'decrypt'] for AES, ['sign', 'verify'] for HMAC
     *
     * @param alg - Key algorithm
     * @returns Generated key (extractable=true)
     */
    async genkey(alg: KeyAlg): Promise<CryptoKey> {
        switch (alg) {
            case 'aes-256':
                // WHY: Generate AES-256 key for AES-GCM (can also use for CBC)
                return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
                    'encrypt',
                    'decrypt',
                ]);
            case 'aes-128':
                // WHY: Generate AES-128 key (faster, slightly less secure)
                return crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, [
                    'encrypt',
                    'decrypt',
                ]);
            case 'hmac-sha256':
                // WHY: Generate HMAC key for message authentication
                return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, [
                    'sign',
                    'verify',
                ]);
            default:
                throw new Error(`Unsupported key algorithm: ${alg}`);
        }
    }

    // =========================================================================
    // KEY DERIVATION
    // =========================================================================

    /**
     * Derive key from password.
     *
     * WHY: Converts passwords into cryptographic keys. Slow by design to
     * resist brute-force attacks.
     *
     * ALGORITHM (pbkdf2-sha256):
     * 1. Import password as key material
     * 2. Derive 256 bits using PBKDF2 with salt and 100k iterations
     * 3. Return derived key bytes
     *
     * ALGORITHM (argon2id):
     * 1. Convert password to string (Bun.password expects string)
     * 2. Hash with argon2id (64MB memory, 3 iterations)
     * 3. Return hash string (includes salt and parameters)
     *
     * NOTE: For argon2id, output is a hash string (not raw key bytes).
     * For PBKDF2, output is raw key bytes.
     *
     * @param alg - KDF algorithm
     * @param password - Password bytes
     * @param salt - Salt bytes (ignored for argon2id)
     * @returns Derived key bytes (or hash string for argon2id)
     */
    async derive(alg: KdfAlg, password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
        switch (alg) {
            case 'pbkdf2-sha256': {
                // Import password as key material
                // WHY: crypto.subtle requires CryptoKey, not raw bytes
                const keyMaterial = await crypto.subtle.importKey(
                    'raw',
                    password.buffer.slice(password.byteOffset, password.byteOffset + password.byteLength) as ArrayBuffer,
                    'PBKDF2',
                    false,
                    ['deriveBits']
                );

                // Derive key bits
                // WHY: 100k iterations provides good security/performance tradeoff
                const bits = await crypto.subtle.deriveBits(
                    {
                        name: 'PBKDF2',
                        salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
                        iterations: 100000,
                        hash: 'SHA-256',
                    },
                    keyMaterial,
                    256
                );

                return new Uint8Array(bits);
            }

            case 'argon2id': {
                // WHY: argon2id is memory-hard, resistant to GPU/ASIC attacks
                // Convert password to string (Bun.password API expects string)
                const passwordStr = new TextDecoder().decode(password);

                // Hash with argon2id
                // WHY: 64MB memory cost, 3 iterations provides strong security
                const hashStr = await Bun.password.hash(passwordStr, {
                    algorithm: 'argon2id',
                    memoryCost: 65536, // 64 MB
                    timeCost: 3,
                });

                // Return hash string as bytes
                // WHY: Hash includes salt and parameters (needed for verify)
                return new TextEncoder().encode(hashStr);
            }

            default:
                throw new Error(`Unsupported KDF: ${alg}`);
        }
    }

    /**
     * Verify password against hash.
     *
     * WHY: Checks if password matches a previously derived hash. Constant-time
     * comparison prevents timing attacks.
     *
     * ALGORITHM:
     * 1. Convert hash and password to strings
     * 2. Call Bun.password.verify() (constant-time comparison)
     * 3. Return result
     *
     * NOTE: Only applicable for argon2id hashes (Bun.password API).
     * For PBKDF2, caller must derive and compare manually.
     *
     * @param hash - Previously derived hash
     * @param password - Password to verify
     * @returns True if password matches
     */
    async verify(hash: Uint8Array, password: Uint8Array): Promise<boolean> {
        const hashStr = new TextDecoder().decode(hash);
        const passwordStr = new TextDecoder().decode(password);

        // WHY: Bun.password.verify uses constant-time comparison
        return Bun.password.verify(passwordStr, hashStr);
    }
}
