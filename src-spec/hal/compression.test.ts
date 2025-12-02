/**
 * Compression Device Tests
 */

import { describe, it, expect } from 'bun:test';
import { BunCompressionDevice, MockCompressionDevice } from '@src/hal/compression.js';

describe('BunCompressionDevice', () => {
    const device = new BunCompressionDevice();

    describe('gzip', () => {
        it('should compress and decompress data', () => {
            const data = new TextEncoder().encode('Hello, Monk OS!');
            const compressed = device.gzip(data);
            const decompressed = device.gunzip(compressed);

            expect(decompressed).toEqual(data);
        });

        it('should compress data smaller than original for compressible input', () => {
            const data = new TextEncoder().encode('A'.repeat(1000));
            const compressed = device.gzip(data);

            expect(compressed.length).toBeLessThan(data.length);
        });

        it('should support compression levels', () => {
            const data = new TextEncoder().encode('Hello, World! '.repeat(100));

            const fast = device.gzip(data, { level: 1 });
            const best = device.gzip(data, { level: 9 });

            // Both should decompress correctly
            expect(device.gunzip(fast)).toEqual(data);
            expect(device.gunzip(best)).toEqual(data);

            // Best compression should be smaller or equal
            expect(best.length).toBeLessThanOrEqual(fast.length);
        });

        it('should handle empty data', () => {
            const data = new Uint8Array(0);
            const compressed = device.gzip(data);
            const decompressed = device.gunzip(compressed);

            expect(decompressed.length).toBe(0);
        });

        it('should handle binary data', () => {
            const data = new Uint8Array([0, 1, 2, 255, 254, 253, 0, 0, 0]);
            const compressed = device.gzip(data);
            const decompressed = device.gunzip(compressed);

            expect(decompressed).toEqual(data);
        });
    });

    describe('deflate', () => {
        it('should compress and decompress data', () => {
            const data = new TextEncoder().encode('Hello, Monk OS!');
            const compressed = device.deflate(data);
            const decompressed = device.inflate(compressed);

            expect(decompressed).toEqual(data);
        });

        it('should produce smaller output than gzip (no headers)', () => {
            const data = new TextEncoder().encode('Hello, World!');
            const gzipped = device.gzip(data);
            const deflated = device.deflate(data);

            // Deflate has no headers, should be smaller
            expect(deflated.length).toBeLessThan(gzipped.length);
        });

        it('should handle empty data', () => {
            const data = new Uint8Array(0);
            const compressed = device.deflate(data);
            const decompressed = device.inflate(compressed);

            expect(decompressed.length).toBe(0);
        });
    });

    describe('compress/decompress generic', () => {
        it('should work with gzip algorithm', () => {
            const data = new TextEncoder().encode('Test data');
            const compressed = device.compress('gzip', data);
            const decompressed = device.decompress('gzip', compressed);

            expect(decompressed).toEqual(data);
        });

        it('should work with deflate algorithm', () => {
            const data = new TextEncoder().encode('Test data');
            const compressed = device.compress('deflate', data);
            const decompressed = device.decompress('deflate', compressed);

            expect(decompressed).toEqual(data);
        });

        it('should throw on unknown algorithm', () => {
            const data = new TextEncoder().encode('Test');

            expect(() => device.compress('unknown' as any, data)).toThrow();
            expect(() => device.decompress('unknown' as any, data)).toThrow();
        });
    });

    describe('large data', () => {
        it('should handle 1MB of data', () => {
            const data = new Uint8Array(1024 * 1024);
            for (let i = 0; i < data.length; i++) {
                data[i] = i % 256;
            }

            const compressed = device.gzip(data);
            const decompressed = device.gunzip(compressed);

            expect(decompressed).toEqual(data);
        });
    });
});

describe('MockCompressionDevice', () => {
    const device = new MockCompressionDevice();

    it('should round-trip data for gzip', () => {
        const data = new TextEncoder().encode('Test data');
        const compressed = device.gzip(data);
        const decompressed = device.gunzip(compressed);

        expect(decompressed).toEqual(data);
    });

    it('should round-trip data for deflate', () => {
        const data = new TextEncoder().encode('Test data');
        const compressed = device.deflate(data);
        const decompressed = device.inflate(compressed);

        expect(decompressed).toEqual(data);
    });

    it('should throw on algorithm mismatch', () => {
        const data = new TextEncoder().encode('Test');
        const compressed = device.gzip(data);

        expect(() => device.inflate(compressed)).toThrow();
    });

    it('should throw on invalid data', () => {
        const invalid = new Uint8Array([0, 1, 2, 3]);

        expect(() => device.gunzip(invalid)).toThrow();
    });
});
