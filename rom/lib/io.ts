/**
 * Buffered I/O Library for VFS Scripts
 *
 * Provides ByteReader and ByteWriter for precise control over streaming byte data.
 */

/**
 * Concatenate two Uint8Arrays.
 */
export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
}

/**
 * Concatenate multiple Uint8Arrays into one.
 */
export function concatAll(arrays: Uint8Array[]): Uint8Array {
    if (arrays.length === 0) return new Uint8Array(0);
    const firstArray = arrays[0];
    if (arrays.length === 1 && firstArray !== undefined) return firstArray;

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
 * ByteReader - Consume an AsyncIterable<Uint8Array> with precise byte control.
 *
 * Wraps a streaming source and provides methods to read exact byte counts,
 * read until delimiters, or read lines. Maintains an internal buffer to
 * handle chunk boundaries transparently.
 *
 * @example
 * // Interactive shell input
 * const stdin = new ByteReader(read(0));
 * while (true) {
 *     const line = await stdin.readLine();
 *     if (line === null) break;
 *     await execute(line);
 * }
 *
 * @example
 * // Protocol parsing - read fixed header then variable body
 * const reader = new ByteReader(read(socketFd));
 * const header = await reader.read(4);  // Exactly 4 bytes
 * const length = new DataView(header.buffer).getUint32(0);
 * const body = await reader.read(length);
 */
export class ByteReader {
    private iterator: AsyncIterator<Uint8Array>;
    private buffer: Uint8Array = new Uint8Array(0);
    private eof = false;

    constructor(source: AsyncIterable<Uint8Array>) {
        this.iterator = source[Symbol.asyncIterator]();
    }

    /**
     * True if EOF reached and internal buffer is empty.
     */
    get done(): boolean {
        return this.eof && this.buffer.length === 0;
    }

    /**
     * Ensure internal buffer has at least n bytes (or hit EOF).
     */
    private async fill(n: number): Promise<void> {
        while (this.buffer.length < n && !this.eof) {
            const { value, done } = await this.iterator.next();
            if (done) {
                this.eof = true;
                break;
            }
            this.buffer = concat(this.buffer, value);
        }
    }

    /**
     * Read exactly n bytes (or fewer at EOF).
     *
     * @param n - Number of bytes to read
     * @returns Uint8Array of length n (or less if EOF)
     */
    async read(n: number): Promise<Uint8Array> {
        await this.fill(n);
        const result = this.buffer.subarray(0, Math.min(n, this.buffer.length));
        this.buffer = this.buffer.subarray(result.length);
        return result;
    }

    /**
     * Peek at the next n bytes without consuming them.
     *
     * @param n - Number of bytes to peek
     * @returns Uint8Array of up to n bytes
     */
    async peek(n: number): Promise<Uint8Array> {
        await this.fill(n);
        return this.buffer.subarray(0, Math.min(n, this.buffer.length));
    }

    /**
     * Read until delimiter byte (inclusive), or EOF.
     *
     * @param delim - Byte value to stop at (included in result)
     * @returns Bytes up to and including delimiter, or null if EOF with no data
     */
    async readUntil(delim: number): Promise<Uint8Array | null> {
        while (true) {
            const idx = this.buffer.indexOf(delim);
            if (idx !== -1) {
                const result = this.buffer.subarray(0, idx + 1);
                this.buffer = this.buffer.subarray(idx + 1);
                return result;
            }
            if (this.eof) {
                if (this.buffer.length === 0) return null;
                const result = this.buffer;
                this.buffer = new Uint8Array(0);
                return result;
            }
            // Need more data - fill at least one more chunk
            const prevLen = this.buffer.length;
            await this.fill(prevLen + 1);
            // If no progress, we hit EOF
            if (this.buffer.length === prevLen) {
                if (this.buffer.length === 0) return null;
                const result = this.buffer;
                this.buffer = new Uint8Array(0);
                return result;
            }
        }
    }

    /**
     * Read one line (without the newline character).
     * Handles LF, CR, and CRLF line endings.
     *
     * @returns Line string, or null if EOF with no data
     */
    async readLine(): Promise<string | null> {
        const bytes = await this.readUntil(0x0a); // LF
        if (bytes === null) return null;

        let end = bytes.length;

        // Strip trailing LF
        if (end > 0 && bytes[end - 1] === 0x0a) {
            end--;
        }
        // Strip trailing CR (for CRLF)
        if (end > 0 && bytes[end - 1] === 0x0d) {
            end--;
        }

        return new TextDecoder().decode(bytes.subarray(0, end));
    }
}

/**
 * ByteWriter - Produce an AsyncIterable<Uint8Array> from pushed bytes.
 *
 * Allows imperative code to push bytes and have consumers pull them
 * via async iteration. Useful for generating streaming output, protocol
 * encoding, or connecting synchronous producers to async consumers.
 *
 * @example
 * // Generate streaming response
 * const writer = new ByteWriter();
 *
 * // Producer (can be sync or async)
 * writer.writeLine('HTTP/1.1 200 OK');
 * writer.writeLine('Content-Type: text/plain');
 * writer.writeLine('');
 * writer.writeLine('Hello, World!');
 * writer.end();
 *
 * // Consumer
 * for await (const chunk of writer) {
 *     await socket.write(chunk);
 * }
 *
 * @example
 * // Pipe transformation
 * async function transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
 *     const writer = new ByteWriter();
 *
 *     (async () => {
 *         for await (const chunk of input) {
 *             writer.write(processChunk(chunk));
 *         }
 *         writer.end();
 *     })();
 *
 *     return writer;
 * }
 */
/** Default high water mark for ByteWriter backpressure (64KB) */
const BYTE_WRITER_HIGH_WATER = 64 * 1024;

export class ByteWriter implements AsyncIterable<Uint8Array> {
    private chunks: Uint8Array[] = [];
    private buffer: Uint8Array = new Uint8Array(0);
    private chunkSize: number;
    private highWaterMark: number;
    private queuedBytes = 0;
    private ended = false;
    private error: Error | null = null;

    // For async iteration - resolvers for pending reads
    private waiting: Array<{
        resolve: (result: IteratorResult<Uint8Array>) => void;
        reject: (error: Error) => void;
    }> = [];

    // For backpressure - resolvers waiting for drain
    private drainWaiters: Array<() => void> = [];

    constructor(chunkSize: number = 65536, highWaterMark: number = BYTE_WRITER_HIGH_WATER) {
        this.chunkSize = chunkSize;
        this.highWaterMark = highWaterMark;
    }

    /**
     * Returns true if the queued bytes exceed the high water mark.
     * Producers should check this and call waitForDrain() if true.
     */
    get full(): boolean {
        return this.queuedBytes >= this.highWaterMark;
    }

    /**
     * Returns a promise that resolves when queued bytes drop below high water mark.
     * Use this to implement backpressure in producers.
     *
     * @example
     * for (const chunk of largeData) {
     *     if (writer.full) {
     *         await writer.waitForDrain();
     *     }
     *     writer.write(chunk);
     * }
     */
    waitForDrain(): Promise<void> {
        if (!this.full) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.drainWaiters.push(resolve);
        });
    }

    /**
     * Write bytes to the stream.
     * Data may be buffered until chunkSize is reached or flush() is called.
     */
    write(data: Uint8Array): void {
        if (this.ended) {
            throw new Error('Cannot write to ended ByteWriter');
        }

        this.buffer = concat(this.buffer, data);

        // Flush complete chunks
        while (this.buffer.length >= this.chunkSize) {
            const chunk = this.buffer.subarray(0, this.chunkSize);
            this.buffer = this.buffer.subarray(this.chunkSize);
            this.emit(new Uint8Array(chunk)); // Copy to avoid shared buffer issues
        }
    }

    /**
     * Write a string line (with trailing newline).
     */
    writeLine(line: string): void {
        this.write(new TextEncoder().encode(line + '\n'));
    }

    /**
     * Force any buffered data to be emitted immediately.
     */
    flush(): void {
        if (this.buffer.length > 0) {
            this.emit(new Uint8Array(this.buffer)); // Copy to avoid shared buffer issues
            this.buffer = new Uint8Array(0);
        }
    }

    /**
     * Signal that no more data will be written.
     * Flushes any remaining buffer and completes the stream.
     */
    end(): void {
        if (this.ended) return;
        this.flush();
        this.ended = true;

        // Resolve any waiting consumers with done
        for (const waiter of this.waiting) {
            waiter.resolve({ done: true, value: undefined });
        }
        this.waiting = [];
    }

    /**
     * Signal an error condition.
     * Any waiting consumers will receive the error.
     */
    abort(error: Error): void {
        this.error = error;
        this.ended = true;

        for (const waiter of this.waiting) {
            waiter.reject(error);
        }
        this.waiting = [];
    }

    /**
     * Emit a chunk to waiting consumers or queue it.
     */
    private emit(chunk: Uint8Array): void {
        if (this.waiting.length > 0) {
            const waiter = this.waiting.shift()!;
            waiter.resolve({ done: false, value: chunk });
        } else {
            this.chunks.push(chunk);
            this.queuedBytes += chunk.length;
        }
    }

    /**
     * Notify drain waiters if buffer has space.
     */
    private notifyDrain(): void {
        if (!this.full && this.drainWaiters.length > 0) {
            const waiters = this.drainWaiters;
            this.drainWaiters = [];
            for (const resolve of waiters) {
                resolve();
            }
        }
    }

    /**
     * AsyncIterator implementation.
     */
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
            next: async (): Promise<IteratorResult<Uint8Array>> => {
                // Check for error
                if (this.error) {
                    throw this.error;
                }

                // Return queued chunk if available
                if (this.chunks.length > 0) {
                    const chunk = this.chunks.shift()!;
                    this.queuedBytes -= chunk.length;
                    this.notifyDrain();
                    return { done: false, value: chunk };
                }

                // If ended, we're done
                if (this.ended) {
                    return { done: true, value: undefined };
                }

                // Wait for next chunk
                return new Promise((resolve, reject) => {
                    this.waiting.push({ resolve, reject });
                });
            },
        };
    }
}
