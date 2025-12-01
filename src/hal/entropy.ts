/**
 * Entropy Device
 *
 * Cryptographically secure random number generation.
 *
 * Bun touchpoints:
 * - crypto.getRandomValues() for random bytes
 * - Date.now() for UUID v7 timestamp
 *
 * Caveats:
 * - getRandomValues() is synchronous and may block if entropy pool depleted
 * - On Linux, uses /dev/urandom (non-blocking) not /dev/random
 * - Maximum single request is 65536 bytes (browser spec limit)
 * - UUIDs are v7 (timestamp-sortable per RFC 9562)
 *
 * Host leakage:
 * - Uses host OS entropy pool. Quality depends on host entropy sources.
 * - In practice, modern OS entropy is high quality and this is not a concern.
 */

/**
 * Entropy device interface.
 */
export interface EntropyDevice {
    /**
     * Get random bytes.
     *
     * Bun: crypto.getRandomValues()
     *
     * Caveat: Synchronous call. For very large requests, may have
     * noticeable latency. Maximum single request is 65536 bytes.
     *
     * @param size - Number of bytes (max 65536)
     * @returns Cryptographically secure random bytes
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
     * Benefits:
     * - Timestamp-sortable (created_at ordering is free)
     * - Better index locality in databases
     * - Still random enough to be unguessable
     *
     * @returns UUID string (36 chars: 8-4-4-4-12 with hyphens)
     */
    uuid(): string;
}

/**
 * Bun entropy device implementation
 *
 * Bun touchpoints:
 * - crypto.getRandomValues(buffer) - fill buffer with random bytes
 * - Date.now() - timestamp for UUID v7
 *
 * Caveats:
 * - Both are synchronous
 * - getRandomValues() limited to 65536 bytes per call
 */
export class BunEntropyDevice implements EntropyDevice {
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

    uuid(): string {
        return uuidv7();
    }
}

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
 */
function uuidv7(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Get current timestamp in milliseconds (48 bits)
    const timestamp = Date.now();

    // Bytes 0-5: 48-bit timestamp (big-endian)
    bytes[0] = (timestamp / 0x10000000000) & 0xff;
    bytes[1] = (timestamp / 0x100000000) & 0xff;
    bytes[2] = (timestamp / 0x1000000) & 0xff;
    bytes[3] = (timestamp / 0x10000) & 0xff;
    bytes[4] = (timestamp / 0x100) & 0xff;
    bytes[5] = timestamp & 0xff;

    // Byte 6: version (0111 = 7) in high nibble, random in low nibble
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;

    // Byte 8: variant (10) in high 2 bits, random in low 6 bits
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    // Format as UUID string
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

/**
 * Seeded entropy device for testing
 *
 * Provides deterministic "random" values based on a seed.
 * Uses a simple xorshift128+ PRNG (not cryptographically secure).
 *
 * Usage:
 *   const entropy = new SeededEntropyDevice(12345);
 *   const a = entropy.read(16);
 *   entropy.reset();
 *   const b = entropy.read(16);
 *   // a and b are identical
 */
export class SeededEntropyDevice implements EntropyDevice {
    private state: [bigint, bigint];
    private initialSeed: number;
    private uuidCounter = 0;

    constructor(seed: number = 0) {
        this.initialSeed = seed;
        this.state = this.initState(seed);
    }

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
     */
    reset(): void {
        this.state = this.initState(this.initialSeed);
        this.uuidCounter = 0;
    }

    /**
     * Set a new seed.
     */
    seed(seed: number): void {
        this.initialSeed = seed;
        this.reset();
    }

    private next(): bigint {
        // xorshift128+
        let [s0, s1] = this.state;
        const result = (s0 + s1) & 0xffffffffffffffffn;

        s1 ^= s0;
        this.state = [
            ((s0 << 24n) | (s0 >> 40n)) ^ s1 ^ (s1 << 16n),
            (s1 << 37n) | (s1 >> 27n),
        ];

        return result;
    }

    read(size: number): Uint8Array {
        const buffer = new Uint8Array(size);

        for (let i = 0; i < size; i += 8) {
            const value = this.next();
            for (let j = 0; j < 8 && i + j < size; j++) {
                buffer[i + j] = Number((value >> BigInt(j * 8)) & 0xffn);
            }
        }

        return buffer;
    }

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
