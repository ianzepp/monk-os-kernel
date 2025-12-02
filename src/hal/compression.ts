/**
 * Compression Device
 *
 * Synchronous compression and decompression using Bun's built-in algorithms.
 *
 * Bun touchpoints:
 * - Bun.gzipSync() / Bun.gunzipSync() - gzip format (RFC 1952)
 * - Bun.deflateSync() / Bun.inflateSync() - raw deflate (RFC 1951)
 *
 * Supported algorithms:
 * - gzip: Standard gzip with headers (most compatible)
 * - deflate: Raw deflate without headers (smaller)
 *
 * Caveats:
 * - All operations are synchronous and block the event loop
 * - For very large data, consider chunking or using worker threads
 * - Compression level 1-9 (1=fastest, 9=smallest, default=6)
 */

import { EINVAL } from './errors.js';

/**
 * Compression algorithm type.
 */
export type CompressionAlg = 'gzip' | 'deflate';

/**
 * Compression level (matches Bun's ZlibCompressionOptions).
 * -1 = default, 0 = none, 1 = fastest, 9 = best
 */
export type CompressionLevel = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Compression options.
 */
export interface CompressionOpts {
    /**
     * Compression level (0-9).
     * 0 = no compression
     * 1 = fastest, largest output
     * 9 = slowest, smallest output
     * Default: 6
     */
    level?: CompressionLevel;
}

/**
 * Compression device interface.
 */
export interface CompressionDevice {
    /**
     * Compress data using the specified algorithm.
     *
     * @param alg - Algorithm: 'gzip' or 'deflate'
     * @param data - Data to compress
     * @param opts - Compression options
     * @returns Compressed data
     */
    compress(alg: CompressionAlg, data: Uint8Array, opts?: CompressionOpts): Uint8Array;

    /**
     * Decompress data using the specified algorithm.
     *
     * @param alg - Algorithm: 'gzip' or 'deflate'
     * @param data - Compressed data
     * @returns Decompressed data
     */
    decompress(alg: CompressionAlg, data: Uint8Array): Uint8Array;

    /**
     * Convenience: gzip compress.
     */
    gzip(data: Uint8Array, opts?: CompressionOpts): Uint8Array;

    /**
     * Convenience: gzip decompress.
     */
    gunzip(data: Uint8Array): Uint8Array;

    /**
     * Convenience: deflate compress.
     */
    deflate(data: Uint8Array, opts?: CompressionOpts): Uint8Array;

    /**
     * Convenience: deflate decompress (inflate).
     */
    inflate(data: Uint8Array): Uint8Array;
}

/**
 * Bun compression device implementation.
 *
 * Uses Bun's native compression APIs for high performance.
 */
export class BunCompressionDevice implements CompressionDevice {
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
                throw new EINVAL(`Unknown compression algorithm: ${alg}`);
        }
    }

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

/**
 * Mock compression device for testing.
 *
 * Does not actually compress - returns data as-is with a marker byte.
 * Useful for testing compression logic without actual compression overhead.
 */
export class MockCompressionDevice implements CompressionDevice {
    private static readonly MARKER = 0xff;

    compress(alg: CompressionAlg, data: Uint8Array, _opts?: CompressionOpts): Uint8Array {
        // Prepend marker byte and algorithm indicator
        const algByte = alg === 'gzip' ? 0x01 : 0x02;
        const result = new Uint8Array(data.length + 2);
        result[0] = MockCompressionDevice.MARKER;
        result[1] = algByte;
        result.set(data, 2);
        return result;
    }

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
