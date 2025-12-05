/**
 * ROM I/O Library Tests
 *
 * Tests for ByteReader and ByteWriter utilities.
 */

import { describe, it, expect } from 'bun:test';
import { ByteReader, ByteWriter } from '@os/io';

describe('ByteReader', () => {
    it('should read bytes from async iterable', async () => {
        async function* source(): AsyncIterable<Uint8Array> {
            yield new Uint8Array([1, 2, 3]);
            yield new Uint8Array([4, 5]);
        }

        const reader = new ByteReader(source());
        const chunk1 = await reader.read(2);

        expect(chunk1).toEqual(new Uint8Array([1, 2]));

        const chunk2 = await reader.read(2);

        expect(chunk2).toEqual(new Uint8Array([3, 4]));

        const chunk3 = await reader.read(10);

        expect(chunk3).toEqual(new Uint8Array([5]));
    });

    it('should return empty array at EOF', async () => {
        async function* source(): AsyncIterable<Uint8Array> {
            yield new Uint8Array([1, 2]);
        }

        const reader = new ByteReader(source());

        await reader.read(2);
        const eof = await reader.read(1);

        expect(eof).toEqual(new Uint8Array(0));
    });

    it('should read lines', async () => {
        async function* source(): AsyncIterable<Uint8Array> {
            yield new TextEncoder().encode('hello\nworld\n');
        }

        const reader = new ByteReader(source());

        expect(await reader.readLine()).toBe('hello');
        expect(await reader.readLine()).toBe('world');
        expect(await reader.readLine()).toBeNull();
    });
});

describe('ByteWriter', () => {
    it('should write and iterate bytes', async () => {
        const writer = new ByteWriter(10); // 10 byte chunks

        writer.write(new Uint8Array([1, 2, 3, 4, 5]));
        writer.write(new Uint8Array([6, 7, 8, 9, 10]));
        writer.write(new Uint8Array([11, 12]));
        writer.end();

        const chunks: Uint8Array[] = [];

        for await (const chunk of writer) {
            chunks.push(chunk);
        }

        expect(chunks.length).toBe(2);
        expect(chunks[0]).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
        expect(chunks[1]).toEqual(new Uint8Array([11, 12]));
    });

    it('should throw when writing to ended writer', () => {
        const writer = new ByteWriter();

        writer.end();
        expect(() => writer.write(new Uint8Array([1]))).toThrow('Cannot write to ended ByteWriter');
    });

    it('should report full when queued bytes exceed high water mark', () => {
        const writer = new ByteWriter(10, 20); // 10 byte chunks, 20 byte high water mark

        expect(writer.full).toBe(false);

        // Write 25 bytes - will create 2 chunks of 10 bytes each (20 bytes queued)
        writer.write(new Uint8Array(25));
        expect(writer.full).toBe(true);
    });

    it('should resolve waitForDrain immediately when not full', async () => {
        const writer = new ByteWriter(10, 100);

        // Should resolve immediately since buffer is empty
        await writer.waitForDrain();
        expect(writer.full).toBe(false);
    });

    it('should resolve waitForDrain when consumer drains buffer', async () => {
        const writer = new ByteWriter(10, 15); // 10 byte chunks, 15 byte high water mark

        // Write 20 bytes - creates 2 chunks (20 bytes queued, exceeds 15 byte limit)
        writer.write(new Uint8Array(20));
        expect(writer.full).toBe(true);

        // Start waiting for drain
        let drained = false;
        const drainPromise = writer.waitForDrain().then(() => {
            drained = true;
        });

        // Should not be drained yet
        expect(drained).toBe(false);

        // Consume one chunk (10 bytes) - now 10 bytes queued, below 15 byte limit
        const iterator = writer[Symbol.asyncIterator]();

        await iterator.next();

        // Wait a tick for drain to resolve
        await drainPromise;
        expect(drained).toBe(true);
        expect(writer.full).toBe(false);
    });

    it('should support backpressure pattern', async () => {
        const writer = new ByteWriter(5, 10); // 5 byte chunks, 10 byte high water mark
        const consumed: number[] = [];

        // Consumer that slowly drains
        const consumer = (async () => {
            for await (const chunk of writer) {
                consumed.push(chunk.length);
                // Simulate slow consumer
                await new Promise(r => setTimeout(r, 10));
            }
        })();

        // Producer with backpressure
        for (let i = 0; i < 5; i++) {
            if (writer.full) {
                await writer.waitForDrain();
            }

            writer.write(new Uint8Array(5));
        }

        writer.end();

        await consumer;

        // All chunks should be consumed
        const totalBytes = consumed.reduce((a, b) => a + b, 0);

        expect(totalBytes).toBe(25);
    });
});
