/**
 * Buffered I/O Library for VFS Scripts
 *
 * Provides efficient buffered reading for line-oriented protocols.
 */

import { read } from '/lib/process';

const DEFAULT_BUFFER_SIZE = 4096;

/**
 * BufferedReader provides efficient line-oriented reading from a file descriptor.
 *
 * Instead of reading one byte at a time, it reads chunks and buffers them,
 * scanning for line endings within the buffer.
 */
export class BufferedReader {
    private fd: number;
    private buffer: Uint8Array;
    private bufferStart: number = 0;
    private bufferEnd: number = 0;
    private eof: boolean = false;

    constructor(fd: number, bufferSize: number = DEFAULT_BUFFER_SIZE) {
        this.fd = fd;
        this.buffer = new Uint8Array(bufferSize);
    }

    /**
     * Fill the buffer with more data from the file descriptor.
     * Compacts the buffer first if needed.
     */
    private async fill(): Promise<void> {
        if (this.eof) return;

        // Compact: move remaining data to start of buffer
        if (this.bufferStart > 0) {
            const remaining = this.bufferEnd - this.bufferStart;
            if (remaining > 0) {
                this.buffer.copyWithin(0, this.bufferStart, this.bufferEnd);
            }
            this.bufferEnd = remaining;
            this.bufferStart = 0;
        }

        // Read more data into the buffer
        const space = this.buffer.length - this.bufferEnd;
        if (space > 0) {
            const chunk = await read(this.fd, space);
            if (chunk.length === 0) {
                this.eof = true;
            } else {
                this.buffer.set(chunk, this.bufferEnd);
                this.bufferEnd += chunk.length;
            }
        }
    }

    /**
     * Read a single line from the file descriptor.
     *
     * Returns the line without the trailing newline characters (\r\n or \n).
     * Returns null on EOF if no data remains.
     */
    async readLine(): Promise<string | null> {
        const chunks: Uint8Array[] = [];

        while (true) {
            // Search for LF in current buffer
            for (let i = this.bufferStart; i < this.bufferEnd; i++) {
                if (this.buffer[i] === 0x0a) { // LF
                    // Found line ending - extract the line
                    let lineEnd = i;

                    // Strip trailing CR if present
                    if (lineEnd > this.bufferStart && this.buffer[lineEnd - 1] === 0x0d) {
                        lineEnd--;
                    }

                    const line = this.buffer.slice(this.bufferStart, lineEnd);
                    this.bufferStart = i + 1; // Move past LF

                    // Combine with any previous chunks
                    if (chunks.length === 0) {
                        return new TextDecoder().decode(line);
                    }

                    chunks.push(line);
                    return new TextDecoder().decode(concat(chunks));
                }
            }

            // No LF found - save current buffer contents and read more
            if (this.bufferEnd > this.bufferStart) {
                chunks.push(this.buffer.slice(this.bufferStart, this.bufferEnd));
                this.bufferStart = this.bufferEnd;
            }

            // Try to fill buffer
            await this.fill();

            // If still no data after fill, we're at EOF
            if (this.bufferStart === this.bufferEnd) {
                if (chunks.length === 0) {
                    return null; // True EOF, no partial line
                }
                // Return remaining data as final line (no newline at end of file)
                return new TextDecoder().decode(concat(chunks));
            }
        }
    }

    /**
     * Read exactly n bytes from the file descriptor.
     *
     * Returns a Uint8Array with the requested bytes.
     * May return fewer bytes if EOF is reached.
     */
    async readExact(n: number): Promise<Uint8Array> {
        const chunks: Uint8Array[] = [];
        let remaining = n;

        while (remaining > 0) {
            // Use buffered data first
            const available = this.bufferEnd - this.bufferStart;
            if (available > 0) {
                const take = Math.min(available, remaining);
                chunks.push(this.buffer.slice(this.bufferStart, this.bufferStart + take));
                this.bufferStart += take;
                remaining -= take;
            }

            if (remaining === 0) break;

            // Need more data
            await this.fill();

            // Check for EOF
            if (this.bufferStart === this.bufferEnd) {
                break;
            }
        }

        return concat(chunks);
    }

    /**
     * Check if we've reached EOF and the buffer is empty.
     */
    isEof(): boolean {
        return this.eof && this.bufferStart === this.bufferEnd;
    }

    /**
     * Get the number of buffered bytes available for reading.
     */
    available(): number {
        return this.bufferEnd - this.bufferStart;
    }
}

/**
 * Concatenate multiple Uint8Arrays into one.
 */
function concat(arrays: Uint8Array[]): Uint8Array {
    if (arrays.length === 0) return new Uint8Array(0);
    if (arrays.length === 1) return arrays[0];

    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
