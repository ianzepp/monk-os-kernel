/**
 * Pipe Buffer
 *
 * Shared buffer for pipe communication between processes.
 */

import { EAGAIN } from '@src/kernel/errors.js';

/** Maximum bytes buffered before backpressure is applied */
const PIPE_BUFFER_HIGH_WATER = 64 * 1024; // 64KB

/**
 * Shared buffer for pipe communication
 *
 * Provides in-memory buffering between read and write ends of a pipe.
 * Supports blocking reads when buffer is empty and EOF detection.
 * Applies backpressure when buffer exceeds high water mark.
 */
export class PipeBuffer {
    private chunks: Uint8Array[] = [];
    private totalBytes = 0;
    private writeEndClosed = false;
    private readEndClosed = false;
    private waiters: Array<{ resolve: (data: Uint8Array) => void; reject: (err: Error) => void }> = [];
    private readonly highWaterMark: number;

    constructor(highWaterMark: number = PIPE_BUFFER_HIGH_WATER) {
        this.highWaterMark = highWaterMark;
    }

    /**
     * Check if buffer is at or above high water mark
     */
    get full(): boolean {
        return this.totalBytes >= this.highWaterMark;
    }

    /**
     * Write data to the buffer
     *
     * @throws EPIPE if read end is closed
     * @throws EAGAIN if buffer is full (backpressure)
     */
    write(data: Uint8Array): number {
        if (this.readEndClosed) {
            // Import dynamically to avoid circular dependency
            const { EPIPE } = require('@src/hal/errors.js');
            throw new EPIPE('Read end closed');
        }

        if (data.length === 0) return 0;

        // If there are waiters, give data to the first one directly
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter.resolve(data);
            return data.length;
        }

        // Check capacity - apply backpressure if buffer is full
        if (this.totalBytes + data.length > this.highWaterMark) {
            throw new EAGAIN('Pipe buffer full');
        }

        // Otherwise buffer it
        this.chunks.push(data);
        this.totalBytes += data.length;
        return data.length;
    }

    /**
     * Read data from the buffer
     *
     * Blocks if buffer is empty and write end is open.
     * Returns empty array on EOF (write end closed, buffer empty).
     */
    async read(size?: number): Promise<Uint8Array> {
        // If we have data, return it
        if (this.chunks.length > 0) {
            return this.consumeChunks(size);
        }

        // No data - if write end closed, return EOF
        if (this.writeEndClosed) {
            return new Uint8Array(0);
        }

        // Block until data available or EOF
        return new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
    }

    /**
     * Consume buffered chunks
     */
    private consumeChunks(size?: number): Uint8Array {
        if (this.chunks.length === 0) {
            return new Uint8Array(0);
        }

        // If no size limit or only one chunk, return all
        if (size === undefined || this.chunks.length === 1) {
            const result = this.mergeChunks();
            this.chunks = [];
            this.totalBytes = 0;
            return result;
        }

        // Consume up to size bytes
        const result: Uint8Array[] = [];
        let remaining = size;

        while (remaining > 0 && this.chunks.length > 0) {
            const chunk = this.chunks[0]!; // Safe: checked length > 0
            if (chunk.length <= remaining) {
                result.push(chunk);
                remaining -= chunk.length;
                this.totalBytes -= chunk.length;
                this.chunks.shift();
            } else {
                // Split chunk
                result.push(chunk.slice(0, remaining));
                this.chunks[0] = chunk.slice(remaining);
                this.totalBytes -= remaining;
                remaining = 0;
            }
        }

        return this.mergeArrays(result);
    }

    /**
     * Merge all chunks into single array
     */
    private mergeChunks(): Uint8Array {
        if (this.chunks.length === 1) {
            return this.chunks[0]!; // Safe: checked length === 1
        }
        return this.mergeArrays(this.chunks);
    }

    /**
     * Merge arrays into single array
     */
    private mergeArrays(arrays: Uint8Array[]): Uint8Array {
        if (arrays.length === 0) return new Uint8Array(0);
        if (arrays.length === 1) return arrays[0]!; // Safe: checked length === 1

        const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }
        return result;
    }

    /**
     * Close write end - signals EOF to readers
     */
    closeWriteEnd(): void {
        if (this.writeEndClosed) return;
        this.writeEndClosed = true;

        // Wake all waiters with EOF
        for (const waiter of this.waiters) {
            waiter.resolve(new Uint8Array(0));
        }
        this.waiters = [];
    }

    /**
     * Close read end - causes EPIPE on writes
     */
    closeReadEnd(): void {
        if (this.readEndClosed) return;
        this.readEndClosed = true;

        // Clear buffer since nobody will read it
        this.chunks = [];
        this.totalBytes = 0;

        // Reject any pending waiters (shouldn't happen, but be safe)
        const { EPIPE } = require('@src/hal/errors.js');
        for (const waiter of this.waiters) {
            waiter.reject(new EPIPE('Read end closed'));
        }
        this.waiters = [];
    }

    /**
     * Check if both ends are closed
     */
    get fullyClosed(): boolean {
        return this.writeEndClosed && this.readEndClosed;
    }

    /**
     * Get buffer size (for debugging)
     */
    get size(): number {
        return this.totalBytes;
    }
}
