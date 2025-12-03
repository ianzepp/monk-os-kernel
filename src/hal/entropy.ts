/**
 * Entropy Device - Cryptographically secure random number generation
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Entropy Device provides cryptographically secure random number generation
 * (CSRNG) for the kernel and user processes. It abstracts over the system's
 * entropy sources, which typically include hardware RNGs, timing jitter, and
 * system event entropy.
 *
 * Two primary services are provided:
 * - read(size): Returns cryptographically secure random bytes
 * - uuid(): Generates RFC 9562 UUID v7 (timestamp-sortable, universally unique)
 *
 * Random bytes are generated using the Web Crypto API's getRandomValues(), which
 * is backed by the operating system's CSRNG (e.g., /dev/urandom on Linux,
 * CryptGenRandom on Windows). This provides high-quality entropy suitable for
 * cryptographic keys, session tokens, and security-critical randomness.
 *
 * UUIDs are generated using the UUID v7 format from RFC 9562. Unlike UUID v4
 * (purely random), v7 includes a millisecond timestamp in the first 48 bits.
 * This makes v7 UUIDs naturally sortable by creation time, improving database
 * index locality and enabling efficient time-based queries.
 *
 * Host leakage: The entropy device uses the host OS's entropy pool. Quality
 * depends on host entropy sources (hardware RNGs, timing jitter, system events).
 * In practice, modern OS entropy is high quality and this is not a security
 * concern. However, in highly constrained environments (early boot, VMs without
 * virtio-rng), entropy quality may be reduced.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: read(n) returns exactly n bytes (never less, never more)
 * INV-2: read() output is cryptographically secure (unpredictable)
 * INV-3: uuid() returns RFC 9562 UUID v7 format (36 chars, 8-4-4-4-12 pattern)
 * INV-4: uuid() version bits are 0111 (version 7)
 * INV-5: uuid() variant bits are 10 (RFC 9562 variant)
 * INV-6: uuid() first 48 bits are millisecond timestamp (sortable by time)
 *
 * CONCURRENCY MODEL
 * =================
 * All entropy operations are synchronous and thread-safe. The underlying system
 * CSRNG handles concurrent access safely. JavaScript is single-threaded, so no
 * locking is required at this layer.
 *
 * Multiple processes may request entropy concurrently via syscalls. The kernel
 * serializes syscalls through the event loop, so entropy calls execute one at
 * a time from the kernel's perspective. Each call is independent and atomic.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: No shared mutable state - device is completely stateless
 * RC-2: System CSRNG handles concurrent access internally
 * RC-3: Each operation allocates fresh buffers - no buffer reuse
 * RC-4: UUID timestamp uses Date.now() which is atomic
 *
 * MEMORY MANAGEMENT
 * =================
 * - EntropyDevice has no persistent state, O(1) memory footprint
 * - read() allocates buffer per call, GC'd after use
 * - uuid() allocates temp buffer (16 bytes) and string, GC'd after use
 * - No cleanup required - everything is automatic
 *
 * @module hal/entropy
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Entropy device interface.
 *
 * WHY: Provides abstraction for testability and portability. Tests can inject
 * seeded entropy devices with deterministic output. Alternative implementations
 * could use hardware RNGs, external entropy services, or custom PRNGs.
 */
export interface EntropyDevice {
    /**
     * Get random bytes.
     *
     * Bun implementation: crypto.getRandomValues()
     *
     * WHY crypto.getRandomValues: Web Crypto standard API, backed by system
     * CSRNG. Provides cryptographically secure entropy suitable for keys,
     * tokens, and security-critical randomness.
     *
     * WHY synchronous: System CSRNG is fast (microseconds) and doesn't benefit
     * from async. On Linux, uses non-blocking /dev/urandom which never blocks
     * in practice. Making it async would add complexity without benefit.
     *
     * CAVEAT: Synchronous call. For very large requests, may have noticeable
     * latency (but still microseconds per KB). Maximum single request is 65536
     * bytes per Web Crypto spec - larger requests throw TypeError.
     *
     * WHY 65536 limit: Browser compatibility. Web Crypto spec limits to 64KB
     * to prevent DoS via massive entropy requests. For larger needs, make
     * multiple calls or use a DRBG (deterministic random bit generator).
     *
     * ERROR HANDLING: Throws TypeError if size > 65536. Throws if entropy
     * pool exhausted (extremely rare on modern systems).
     *
     * @param size - Number of bytes (max 65536)
     * @returns Cryptographically secure random bytes
     * @throws TypeError - Size exceeds 65536 bytes
     */
    read(size: number): Uint8Array;

    /**
     * Generate a UUID v7 (timestamp-sortable).
     *
     * UUID v7 per RFC 9562:
     * - First 48 bits: Unix timestamp in milliseconds
     * - Next 4 bits: version (0111 = 7)
     * - Next 12 bits: random
     * - Next 2 bits: variant (10)
     * - Final 62 bits: random
     *
     * Total: 128 bits formatted as 36-char string: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
     *
     * WHY UUID v7: Combines benefits of UUID v4 (random, unguessable) with
     * UUID v1 (timestamp-sortable). Key advantages:
     *
     * 1. Time-sortable: UUIDs sort by creation time without parsing. Database
     *    indexes stay compact (no fragmentation from random UUIDs).
     *
     * 2. Index locality: Sequential UUIDs cluster in database B-trees, improving
     *    cache hit rates and reducing write amplification.
     *
     * 3. Implicit created_at: Timestamp is embedded. No need for separate
     *    created_at column in many cases - just extract from UUID.
     *
     * 4. Still random: 74 bits of randomness (12 + 62) ensures uniqueness even
     *    for millions of UUIDs per millisecond across many nodes.
     *
     * WHY not UUID v4: Purely random UUIDs cause database index fragmentation.
     * Every insert is a random B-tree position, destroying cache locality and
     * causing write amplification. v7 fixes this while remaining unique.
     *
     * WHY not UUID v1: Uses MAC address (privacy leak) and node ID (coordination
     * required). v7 uses random bits instead, eliminating coordination and
     * privacy concerns.
     *
     * @returns UUID string (36 chars: 8-4-4-4-12 with hyphens)
     */
    uuid(): string;
}

// =============================================================================
// MAIN IMPLEMENTATION
// =============================================================================

/**
 * Bun entropy device implementation
 *
 * Bun touchpoints:
 * - crypto.getRandomValues(buffer) - Fill buffer with random bytes
 * - Date.now() - Millisecond timestamp for UUID v7
 *
 * WHY these APIs: crypto.getRandomValues is Web Crypto standard, widely
 * supported, and backed by OS CSRNG. Date.now() provides millisecond precision
 * timestamps, sufficient for UUID v7 (48-bit millisecond field).
 *
 * Caveats:
 * - Both operations are synchronous
 * - getRandomValues() limited to 65536 bytes per call (spec requirement)
 * - UUID timestamp has millisecond precision (not nanosecond)
 * - On extremely high-throughput systems (>1M UUID/ms), consider node ID bits
 *
 * Host leakage:
 * - Uses host OS entropy pool. Quality depends on host entropy sources.
 * - In practice, modern OS entropy is high quality and not a concern.
 * - Early boot or VM environments may have reduced entropy initially.
 *
 * TESTABILITY: Interface allows dependency injection of seeded implementations.
 */
export class BunEntropyDevice implements EntropyDevice {
    // =========================================================================
    // RANDOM BYTES
    // =========================================================================

    /**
     * Generate random bytes.
     *
     * ALGORITHM:
     * 1. Check size <= 65536 (spec limit)
     * 2. Allocate buffer
     * 3. Fill with crypto.getRandomValues()
     * 4. Return buffer
     *
     * WHY check limit: Web Crypto spec requires throwing if size > 65536.
     * Better to fail fast with clear error than pass to crypto and get
     * confusing TypeError.
     *
     * ERROR HANDLING: Throws TypeError with descriptive message if too large.
     * For larger needs, caller should make multiple read() calls or use DRBG.
     *
     * @param size - Number of bytes
     * @returns Random bytes
     * @throws Error - Size exceeds 65536 bytes
     */
    read(size: number): Uint8Array {
        if (size > 65536) {
            // Spec limit: TypeError if > 65536
            // For larger requests, we could loop, but that's unusual
            throw new Error('Entropy read size exceeds 65536 bytes');
        }

        const buffer = new Uint8Array(size);
        crypto.getRandomValues(buffer);
        return buffer;
    }

    // =========================================================================
    // UUID GENERATION
    // =========================================================================

    /**
     * Generate UUID v7.
     *
     * WHY call helper: UUID generation logic is complex enough to deserve
     * its own function. This keeps the method body simple and allows reuse
     * in testing.
     *
     * @returns UUID v7 string
     */
    uuid(): string {
        return uuidv7();
    }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate UUID v7 per RFC 9562.
 *
 * Layout (128 bits total):
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                          unix_ts_ms (32 bits)                |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |   unix_ts_ms (16 bits)  | ver |       rand_a (12 bits)       |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |var|                     rand_b (62 bits)                     |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                        rand_b (continued)                    |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *
 * ALGORITHM:
 * 1. Allocate 16 bytes and fill with random data
 * 2. Get current timestamp in milliseconds
 * 3. Encode timestamp into bytes 0-5 (48 bits, big-endian)
 * 4. Set version bits (byte 6 high nibble = 0111)
 * 5. Set variant bits (byte 8 high 2 bits = 10)
 * 6. Format as hyphenated string (8-4-4-4-12)
 *
 * WHY big-endian timestamp: Makes UUIDs lexicographically sortable by time.
 * String comparison matches chronological order.
 *
 * WHY preserve random bits: Bytes 6 (low nibble), 7, 8 (low 6 bits), 9-15
 * remain random. This provides 74 bits of randomness:
 * - 12 bits in timestamp section
 * - 62 bits in random section
 * Total: 74 bits = 10^22 possible values per millisecond
 *
 * COLLISION RESISTANCE: At 1M UUIDs/ms (very high rate), probability of
 * collision is ~10^-16 (negligible). At 1K UUIDs/ms, probability is ~10^-19.
 *
 * WHY mask instead of shift: Preserves random bits in bytes. We only overwrite
 * specific bit ranges, keeping the rest random.
 *
 * @returns UUID v7 string
 */
function uuidv7(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Get current timestamp in milliseconds (48 bits)
    const timestamp = Date.now();

    // Bytes 0-5: 48-bit timestamp (big-endian)
    // WHY these divisions: JavaScript numbers are 64-bit floats but can represent
    // integers exactly up to 2^53. We're encoding a 48-bit integer, so we use
    // divisions by powers of 256 to extract each byte.
    bytes[0] = (timestamp / 0x10000000000) & 0xff; // Top 8 bits
    bytes[1] = (timestamp / 0x100000000) & 0xff;   // Next 8 bits
    bytes[2] = (timestamp / 0x1000000) & 0xff;     // Next 8 bits
    bytes[3] = (timestamp / 0x10000) & 0xff;       // Next 8 bits
    bytes[4] = (timestamp / 0x100) & 0xff;         // Next 8 bits
    bytes[5] = timestamp & 0xff;                   // Bottom 8 bits

    // Byte 6: version (0111 = 7) in high nibble, random in low nibble
    // WHY mask with 0x0f: Preserves low nibble (random bits)
    // WHY OR with 0x70: Sets high nibble to 0111 (version 7)
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;

    // Byte 8: variant (10) in high 2 bits, random in low 6 bits
    // WHY mask with 0x3f: Preserves low 6 bits (random bits)
    // WHY OR with 0x80: Sets high 2 bits to 10 (RFC 9562 variant)
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    // Format as UUID string
    // WHY map to hex: Standard UUID format is hexadecimal
    // WHY padStart(2, '0'): Ensures each byte is 2 hex digits (leading zeros)
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    // WHY 8-4-4-4-12 format: RFC 9562 standard UUID string format
    // Makes UUIDs recognizable and parseable by standard tools
    return [
        hex.slice(0, 8),   // 8 hex chars (4 bytes)
        hex.slice(8, 12),  // 4 hex chars (2 bytes)
        hex.slice(12, 16), // 4 hex chars (2 bytes) - includes version
        hex.slice(16, 20), // 4 hex chars (2 bytes) - includes variant
        hex.slice(20, 32), // 12 hex chars (6 bytes)
    ].join('-');
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Seeded entropy device for testing
 *
 * WHY: Essential for deterministic tests. Tests can:
 * - Set specific seed for reproducible "random" sequences
 * - Verify UUIDs are unique and properly formatted
 * - Test collision handling without actual randomness
 * - Run in parallel without shared entropy state
 *
 * DESIGN: Uses xorshift128+ PRNG (pseudo-random number generator). Not
 * cryptographically secure - DO NOT use in production. Only for testing.
 *
 * xorshift128+ properties:
 * - Fast (few nanoseconds per value)
 * - Good statistical properties (passes most randomness tests)
 * - Deterministic (same seed = same sequence)
 * - Full period (2^128-1 values before repeat)
 *
 * WHY xorshift128+: Simple, fast, good enough for testing. Real CSRNG would
 * be overkill and slower.
 *
 * TESTABILITY: Enables deterministic tests with reset() for isolation.
 *
 * Usage:
 *   const entropy = new SeededEntropyDevice(12345);
 *   const a = entropy.read(16);
 *   entropy.reset();
 *   const b = entropy.read(16);
 *   // a and b are identical (deterministic)
 */
export class SeededEntropyDevice implements EntropyDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * PRNG state (xorshift128+).
     *
     * WHY two 64-bit values: xorshift128+ requires 128 bits of state. Using
     * two bigints allows 64-bit arithmetic without overflow concerns.
     *
     * WHY bigint: JavaScript numbers are 64-bit floats with 53-bit integer
     * precision. We need full 64-bit arithmetic for xorshift128+.
     */
    private state: [bigint, bigint];

    /**
     * Initial seed for reset().
     *
     * WHY save: Allows reset() to restore original seed without caller tracking it.
     */
    private initialSeed: number;

    /**
     * Counter for UUID timestamp field.
     *
     * WHY: In tests, we want deterministic UUIDs that are still sortable.
     * Using counter instead of Date.now() gives determinism while preserving
     * sort order (counter increments).
     *
     * TESTABILITY: Tests can verify UUIDs sort chronologically even though
     * times are fake.
     */
    private uuidCounter = 0;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Create seeded entropy device.
     *
     * WHY default seed 0: Allows new SeededEntropyDevice() without arguments
     * while still being deterministic.
     *
     * @param seed - Seed value (default 0)
     */
    constructor(seed: number = 0) {
        this.initialSeed = seed;
        this.state = this.initState(seed);
    }

    /**
     * Initialize PRNG state from seed.
     *
     * ALGORITHM: Uses SplitMix64 to generate initial state from seed.
     * SplitMix64 is a simple, fast PRNG designed for initializing other PRNGs.
     *
     * WHY SplitMix64: Generates high-quality initialization values from any
     * seed. Ensures even seeds like 0, 1, 2 produce uncorrelated state.
     *
     * WHY two calls: xorshift128+ needs 128 bits of state. We call SplitMix64
     * twice to get two independent 64-bit values.
     *
     * @param seed - Seed value
     * @returns Initial state [s0, s1]
     */
    private initState(seed: number): [bigint, bigint] {
        // Initialize state from seed using splitmix64
        let s = BigInt(seed);
        const next = () => {
            s = (s + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
            let z = s;
            z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
            z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
            return z ^ (z >> 31n);
        };
        return [next(), next()];
    }

    /**
     * Reset to initial seed state.
     *
     * WHY: Allows tests to replay the same "random" sequence. Essential for
     * test isolation - each test can reset to known state.
     *
     * TESTABILITY: Enables deterministic test behavior and independence.
     */
    reset(): void {
        this.state = this.initState(this.initialSeed);
        this.uuidCounter = 0;
    }

    /**
     * Set a new seed.
     *
     * WHY: Allows tests to change seed mid-test, simulating different random
     * scenarios without creating new instances.
     *
     * @param seed - New seed value
     */
    seed(seed: number): void {
        this.initialSeed = seed;
        this.reset();
    }

    // =========================================================================
    // PRNG CORE
    // =========================================================================

    /**
     * Generate next random 64-bit value.
     *
     * ALGORITHM: xorshift128+ (Marsaglia, Vigna)
     * 1. result = s0 + s1 (mod 2^64)
     * 2. s1 ^= s0
     * 3. s0 = rotl(s0, 24) ^ s1 ^ (s1 << 16)
     * 4. s1 = rotl(s1, 37)
     * 5. return result
     *
     * WHY xorshift128+: Fast, simple, good statistical properties. Period is
     * 2^128-1 (all values except zero state). Designed by Sebastiano Vigna,
     * used in V8 and other production systems (for non-crypto).
     *
     * WHY rotl: Rotate left provides better mixing than shift. Implemented as
     * (x << n) | (x >> (64-n)) in 64-bit arithmetic.
     *
     * @returns 64-bit random value
     */
    private next(): bigint {
        // xorshift128+
        let [s0, s1] = this.state;
        const result = (s0 + s1) & 0xffffffffffffffffn;

        s1 ^= s0;
        this.state = [
            // rotl(s0, 24) ^ s1 ^ (s1 << 16)
            ((s0 << 24n) | (s0 >> 40n)) ^ s1 ^ (s1 << 16n),
            // rotl(s1, 37)
            (s1 << 37n) | (s1 >> 27n),
        ];

        return result;
    }

    // =========================================================================
    // ENTROPYDEVICE IMPLEMENTATION
    // =========================================================================

    /**
     * Generate pseudo-random bytes.
     *
     * ALGORITHM:
     * 1. Allocate buffer
     * 2. Loop in 8-byte chunks:
     *    a. Generate 64-bit random value
     *    b. Extract 8 bytes (little-endian)
     *    c. Write to buffer
     * 3. Handle partial final chunk if size not multiple of 8
     * 4. Return buffer
     *
     * WHY 8-byte chunks: xorshift128+ produces 64-bit values. Processing in
     * 8-byte chunks is efficient and avoids bit waste.
     *
     * WHY little-endian: Matches most architectures. Doesn't really matter
     * for random data, but consistent extraction is cleaner.
     *
     * @param size - Number of bytes
     * @returns Pseudo-random bytes
     */
    read(size: number): Uint8Array {
        const buffer = new Uint8Array(size);

        for (let i = 0; i < size; i += 8) {
            const value = this.next();
            // Extract bytes (little-endian)
            for (let j = 0; j < 8 && i + j < size; j++) {
                buffer[i + j] = Number((value >> BigInt(j * 8)) & 0xffn);
            }
        }

        return buffer;
    }

    /**
     * Generate deterministic UUID v7-like string.
     *
     * ALGORITHM:
     * 1. Generate 16 random bytes
     * 2. Use incrementing counter for timestamp (deterministic ordering)
     * 3. Encode counter into bytes 0-5 (big-endian)
     * 4. Set version bits (0111)
     * 5. Set variant bits (10)
     * 6. Format as hyphenated string
     *
     * WHY counter instead of Date.now(): Tests need deterministic UUIDs that
     * are still sortable. Counter provides both - deterministic values that
     * sort chronologically.
     *
     * WHY v7 format: Even in tests, maintaining v7 format ensures code that
     * parses/validates UUIDs works correctly.
     *
     * TESTABILITY: Tests can verify UUIDs are unique, properly formatted, and
     * sortable by creation order.
     *
     * @returns UUID v7 string (deterministic)
     */
    uuid(): string {
        // Generate deterministic UUID v7-like string
        // Uses counter for timestamp to maintain determinism while being sortable
        const bytes = this.read(16);

        // Use incrementing counter for timestamp portion (deterministic ordering)
        const timestamp = this.uuidCounter++;

        // Bytes 0-5: 48-bit "timestamp" (big-endian) - uses counter for determinism
        bytes[0] = (timestamp / 0x10000000000) & 0xff;
        bytes[1] = (timestamp / 0x100000000) & 0xff;
        bytes[2] = (timestamp / 0x1000000) & 0xff;
        bytes[3] = (timestamp / 0x10000) & 0xff;
        bytes[4] = (timestamp / 0x100) & 0xff;
        bytes[5] = timestamp & 0xff;

        // Set version 7 bits
        bytes[6] = (bytes[6]! & 0x0f) | 0x70;
        // Set variant bits
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;

        const hex = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

        return [
            hex.slice(0, 8),
            hex.slice(8, 12),
            hex.slice(12, 16),
            hex.slice(16, 20),
            hex.slice(20, 32),
        ].join('-');
    }
}
