/**
 * Compression Device - Synchronous data compression and decompression
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Compression Device provides synchronous compression and decompression
 * services using industry-standard algorithms. It abstracts over Bun's native
 * compression APIs to provide a consistent interface for the kernel.
 *
 * Two algorithms are supported:
 * - gzip: Standard gzip format (RFC 1952) with headers and checksums. Most
 *   compatible with external tools and file formats. Slightly larger output
 *   due to headers.
 * - deflate: Raw deflate format (RFC 1951) without headers. Smaller output,
 *   used internally by gzip and in contexts where headers are managed separately
 *   (e.g., HTTP compression, PNG files).
 *
 * All operations are synchronous. This is a deliberate design choice for simplicity
 * and aligns with Bun's sync compression APIs. For very large data (>10MB),
 * consider chunking or offloading to worker processes.
 *
 * The device supports compression levels 0-9, where 0 is no compression (store
 * only), 1 is fastest with largest output, and 9 is slowest with smallest output.
 * Default is 6, which provides a good balance for most use cases.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: decompress(alg, compress(alg, data)) === data (round-trip correctness)
 * INV-2: Compressed data is always valid for the specified algorithm
 * INV-3: Compression level only affects compression, not decompression
 * INV-4: Invalid algorithm throws EINVAL before processing data
 * INV-5: Decompression of invalid data throws appropriate error
 *
 * CONCURRENCY MODEL
 * =================
 * All compression operations are synchronous and block the event loop. This is
 * intentional - Bun's compression APIs are sync, and making them async would
 * add complexity without benefit (the work still blocks).
 *
 * Multiple processes may request compression concurrently via syscalls. The
 * kernel serializes calls through the event loop. Each compression is independent
 * and non-blocking from a kernel perspective (the process blocks, kernel continues).
 *
 * For CPU-intensive compression of large data, consider:
 * - Chunking data and compressing incrementally
 * - Offloading to worker processes via spawn()
 * - Using streaming compression in device implementations (future)
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: No shared state between calls - each operation is pure
 * RC-2: Input data is not modified - Bun APIs take readonly buffers
 * RC-3: Output is allocated fresh for each call - no buffer reuse
 *
 * MEMORY MANAGEMENT
 * =================
 * - Input buffers are not modified or retained
 * - Output buffers are freshly allocated by Bun APIs
 * - Temporary buffers are managed by native code (zlib)
 * - No cleanup required - everything is GC'd
 * - Memory usage peaks at ~input size + output size during operation
 *
 * @module hal/compression
 */

import { EINVAL } from './errors.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Compression algorithm type.
 *
 * WHY only two algorithms: These are the most common and well-supported.
 * gzip is standard for file compression and HTTP. deflate is used internally
 * by many formats (PNG, ZIP, etc.). Other algorithms (brotli, zstd) could be
 * added but aren't yet supported by Bun's sync APIs.
 *
 * TESTABILITY: String literal type enables exhaustive switch checking.
 */
export type CompressionAlg = 'gzip' | 'deflate';

/**
 * Compression level (matches Bun's ZlibCompressionOptions).
 *
 * WHY these values: Standard zlib compression levels. -1 means default (6).
 * 0 is store-only (no compression, just format overhead). 1-9 trade off
 * speed vs compression ratio.
 *
 * WHY -1: Allows "use default" without hardcoding default value in client code.
 * Client can pass undefined or -1 to get default behavior.
 */
export type CompressionLevel = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Compression options.
 *
 * WHY: Encapsulates configuration in an extensible structure. Future options
 * (e.g., memory level, strategy) can be added without changing function signatures.
 *
 * TESTABILITY: Object parameter allows partial specification in tests.
 */
export interface CompressionOpts {
    /**
     * Compression level (0-9).
     *
     * 0 = no compression (store only, fastest but largest output)
     * 1 = fastest compression, largest output
     * 9 = slowest compression, smallest output
     * Default: 6 (good balance for most use cases)
     *
     * WHY 6 as default: zlib's default. Provides ~70% of the compression of
     * level 9 with significantly less CPU time. Most applications won't benefit
     * from higher levels.
     *
     * WHY levels exist: Different use cases have different priorities. Real-time
     * compression (level 1) prioritizes speed. Archival (level 9) prioritizes
     * size. Web responses (level 6) balance both.
     */
    level?: CompressionLevel;
}

/**
 * Compression device interface.
 *
 * WHY: Provides abstraction for testability and future alternative implementations
 * (hardware compression, streaming compression, etc.).
 */
export interface CompressionDevice {
    /**
     * Compress data using the specified algorithm.
     *
     * ALGORITHM:
     * 1. Validate algorithm (throw EINVAL if unknown)
     * 2. Extract compression level from opts (default to undefined for API default)
     * 3. Call appropriate Bun API (gzipSync or deflateSync)
     * 4. Return compressed buffer
     *
     * INVARIANT: Output is valid compressed data for the specified algorithm.
     *
     * @param alg - Algorithm: 'gzip' or 'deflate'
     * @param data - Data to compress
     * @param opts - Compression options (level)
     * @returns Compressed data
     * @throws EINVAL - Unknown algorithm
     */
    compress(alg: CompressionAlg, data: Uint8Array, opts?: CompressionOpts): Uint8Array;

    /**
     * Decompress data using the specified algorithm.
     *
     * ALGORITHM:
     * 1. Validate algorithm (throw EINVAL if unknown)
     * 2. Call appropriate Bun API (gunzipSync or inflateSync)
     * 3. Return decompressed buffer
     *
     * ERROR HANDLING: If data is corrupt or wrong algorithm, Bun will throw.
     * We don't catch - let the error propagate to caller with native error message.
     *
     * @param alg - Algorithm: 'gzip' or 'deflate'
     * @param data - Compressed data
     * @returns Decompressed data
     * @throws EINVAL - Unknown algorithm
     * @throws Error - Corrupt or invalid compressed data
     */
    decompress(alg: CompressionAlg, data: Uint8Array): Uint8Array;

    /**
     * Convenience: gzip compress.
     *
     * WHY: Shorter, more readable for the common case. Equivalent to
     * compress('gzip', data, opts).
     *
     * @param data - Data to compress
     * @param opts - Compression options
     * @returns Gzip-compressed data
     */
    gzip(data: Uint8Array, opts?: CompressionOpts): Uint8Array;

    /**
     * Convenience: gzip decompress.
     *
     * WHY: Shorter, more readable. Equivalent to decompress('gzip', data).
     *
     * @param data - Gzip-compressed data
     * @returns Decompressed data
     */
    gunzip(data: Uint8Array): Uint8Array;

    /**
     * Convenience: deflate compress.
     *
     * WHY: Shorter, more readable. Equivalent to compress('deflate', data, opts).
     *
     * @param data - Data to compress
     * @param opts - Compression options
     * @returns Deflate-compressed data
     */
    deflate(data: Uint8Array, opts?: CompressionOpts): Uint8Array;

    /**
     * Convenience: deflate decompress (inflate).
     *
     * WHY: Shorter, more readable. Named "inflate" to match standard terminology
     * (deflate compresses, inflate decompresses). Equivalent to decompress('deflate', data).
     *
     * @param data - Deflate-compressed data
     * @returns Decompressed data
     */
    inflate(data: Uint8Array): Uint8Array;
}

// =============================================================================
// MAIN IMPLEMENTATION
// =============================================================================

/**
 * Bun compression device implementation.
 *
 * Bun touchpoints:
 * - Bun.gzipSync() / Bun.gunzipSync() - gzip format (RFC 1952)
 * - Bun.deflateSync() / Bun.inflateSync() - raw deflate (RFC 1951)
 *
 * WHY these APIs: Bun provides native, high-performance compression via libz
 * (same library as zlib). Sync APIs are simpler and avoid unnecessary async
 * overhead for operations that must block anyway.
 *
 * WHY synchronous: Compression is CPU-bound work that can't be made truly async
 * without offloading to another thread. JavaScript's event loop can't help here.
 * Bun's sync APIs are honest about this - the work blocks. For large data,
 * chunk or use worker processes.
 *
 * Caveats:
 * - All operations block the event loop until complete
 * - Very large data (>10MB) may cause noticeable latency
 * - Consider chunking or worker processes for large/frequent compression
 * - Compression level affects CPU time exponentially but output size logarithmically
 *
 * TESTABILITY: Interface allows dependency injection of mock implementations.
 */
export class BunCompressionDevice implements CompressionDevice {
    // =========================================================================
    // COMPRESSION
    // =========================================================================

    /**
     * Compress data using specified algorithm.
     *
     * ALGORITHM:
     * 1. Extract compression level from options
     * 2. Cast input to Bun's stricter type (Uint8Array<ArrayBuffer>)
     * 3. Switch on algorithm and call appropriate Bun API
     * 4. Return compressed buffer
     *
     * WHY cast to ArrayBuffer: Bun's types are stricter than standard TypeScript.
     * Uint8Array might have SharedArrayBuffer backing, which Bun's sync APIs
     * don't support. Cast ensures type safety.
     *
     * WHY conditional level passing: If level is undefined, we pass undefined
     * to Bun APIs to get their default. If we passed { level: undefined },
     * Bun might interpret it differently than omitting the options.
     *
     * @param alg - Compression algorithm
     * @param data - Input data
     * @param opts - Compression options
     * @returns Compressed data
     * @throws EINVAL - Unknown algorithm
     */
    compress(alg: CompressionAlg, data: Uint8Array, opts?: CompressionOpts): Uint8Array {
        const level = opts?.level;
        // Cast to satisfy Bun's stricter ArrayBuffer typing
        const input = data as Uint8Array<ArrayBuffer>;

        switch (alg) {
            case 'gzip':
                return Bun.gzipSync(input, level !== undefined ? { level } : undefined);
            case 'deflate':
                return Bun.deflateSync(input, level !== undefined ? { level } : undefined);
            default:
                // TypeScript exhaustiveness check ensures this never happens
                throw new EINVAL(`Unknown compression algorithm: ${alg}`);
        }
    }

    // =========================================================================
    // DECOMPRESSION
    // =========================================================================

    /**
     * Decompress data using specified algorithm.
     *
     * ALGORITHM:
     * 1. Cast input to Bun's stricter type
     * 2. Switch on algorithm and call appropriate Bun API
     * 3. Return decompressed buffer
     *
     * ERROR HANDLING: If data is corrupt, Bun will throw an error with details.
     * We don't catch - the native error message is more informative than anything
     * we could construct.
     *
     * @param alg - Decompression algorithm
     * @param data - Compressed data
     * @returns Decompressed data
     * @throws EINVAL - Unknown algorithm
     * @throws Error - Corrupt or invalid compressed data (from Bun)
     */
    decompress(alg: CompressionAlg, data: Uint8Array): Uint8Array {
        // Cast to satisfy Bun's stricter ArrayBuffer typing
        const input = data as Uint8Array<ArrayBuffer>;

        switch (alg) {
            case 'gzip':
                return Bun.gunzipSync(input);
            case 'deflate':
                return Bun.inflateSync(input);
            default:
                throw new EINVAL(`Unknown compression algorithm: ${alg}`);
        }
    }

    // =========================================================================
    // CONVENIENCE WRAPPERS
    // =========================================================================

    /**
     * Gzip compress.
     *
     * WHY: Shorter syntax for the common case. Most users want gzip by name,
     * not compress('gzip', ...).
     */
    gzip(data: Uint8Array, opts?: CompressionOpts): Uint8Array {
        return this.compress('gzip', data, opts);
    }

    /**
     * Gzip decompress.
     */
    gunzip(data: Uint8Array): Uint8Array {
        return this.decompress('gzip', data);
    }

    /**
     * Deflate compress.
     */
    deflate(data: Uint8Array, opts?: CompressionOpts): Uint8Array {
        return this.compress('deflate', data, opts);
    }

    /**
     * Deflate decompress (inflate).
     *
     * WHY "inflate": Standard terminology. deflate compresses, inflate decompresses.
     * Named after the INFLATE algorithm, not the verb.
     */
    inflate(data: Uint8Array): Uint8Array {
        return this.decompress('deflate', data);
    }
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Mock compression device for testing.
 *
 * WHY: Enables testing of compression-dependent code without actual compression
 * overhead. Tests run faster and can verify compression/decompression logic
 * without caring about the actual compression algorithm.
 *
 * DESIGN: Does not actually compress - returns data as-is with a marker byte
 * and algorithm indicator prepended. This is sufficient for testing that:
 * - Data flows correctly through compression APIs
 * - Round-trip works (compress then decompress returns original)
 * - Algorithm parameter is respected
 * - Error cases are handled
 *
 * TESTABILITY: Allows fast, deterministic tests without real compression complexity.
 *
 * Usage:
 *   const device = new MockCompressionDevice();
 *   const compressed = device.gzip(data);
 *   const decompressed = device.gunzip(compressed);
 *   assert(decompressed.equals(data));
 */
export class MockCompressionDevice implements CompressionDevice {
    // =========================================================================
    // CONSTANTS
    // =========================================================================

    /**
     * Marker byte for mock compressed data.
     *
     * WHY 0xFF: Unlikely to appear at start of real data. Makes it easy to
     * detect mock data vs real compressed data in tests.
     */
    private static readonly MARKER = 0xff;

    // =========================================================================
    // COMPRESSION (MOCK)
    // =========================================================================

    /**
     * Mock compression - prepend marker and algorithm indicator.
     *
     * ALGORITHM:
     * 1. Allocate buffer with 2 extra bytes (marker + algorithm)
     * 2. Write MARKER byte at position 0
     * 3. Write algorithm indicator at position 1 (0x01=gzip, 0x02=deflate)
     * 4. Copy input data starting at position 2
     * 5. Return result
     *
     * WHY this format: Simple to implement, easy to verify in tests, and
     * preserves original data for perfect round-trip.
     *
     * INVARIANT: compressed.length === data.length + 2
     *
     * @param alg - Algorithm (determines indicator byte)
     * @param data - Input data
     * @param _opts - Ignored (not needed for mock)
     * @returns Mock "compressed" data
     */
    compress(alg: CompressionAlg, data: Uint8Array, _opts?: CompressionOpts): Uint8Array {
        // Prepend marker byte and algorithm indicator
        const algByte = alg === 'gzip' ? 0x01 : 0x02;
        const result = new Uint8Array(data.length + 2);

        result[0] = MockCompressionDevice.MARKER;
        result[1] = algByte;
        result.set(data, 2);

        return result;
    }

    // =========================================================================
    // DECOMPRESSION (MOCK)
    // =========================================================================

    /**
     * Mock decompression - verify marker and algorithm, strip header.
     *
     * ALGORITHM:
     * 1. Verify byte 0 is MARKER (throw EINVAL if not)
     * 2. Verify byte 1 matches expected algorithm (throw EINVAL if not)
     * 3. Return data.slice(2) - everything after the header
     *
     * ERROR HANDLING: Validates mock format to catch test errors where real
     * compressed data is passed to mock decompressor or algorithm mismatch.
     *
     * @param alg - Expected algorithm
     * @param data - Mock compressed data
     * @returns Original data
     * @throws EINVAL - Invalid mock data format or algorithm mismatch
     */
    decompress(alg: CompressionAlg, data: Uint8Array): Uint8Array {
        // Verify marker and algorithm
        if (data[0] !== MockCompressionDevice.MARKER) {
            throw new EINVAL('Invalid mock compressed data: missing marker');
        }

        const expectedAlg = alg === 'gzip' ? 0x01 : 0x02;

        if (data[1] !== expectedAlg) {
            throw new EINVAL('Invalid mock compressed data: algorithm mismatch');
        }

        return data.slice(2);
    }

    // =========================================================================
    // CONVENIENCE WRAPPERS
    // =========================================================================

    gzip(data: Uint8Array, opts?: CompressionOpts): Uint8Array {
        return this.compress('gzip', data, opts);
    }

    gunzip(data: Uint8Array): Uint8Array {
        return this.decompress('gzip', data);
    }

    deflate(data: Uint8Array, opts?: CompressionOpts): Uint8Array {
        return this.compress('deflate', data, opts);
    }

    inflate(data: Uint8Array): Uint8Array {
        return this.decompress('deflate', data);
    }
}
