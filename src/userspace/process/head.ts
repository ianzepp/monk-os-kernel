/**
 * Head operations for VFS scripts.
 * Read the beginning of files efficiently.
 */

import { open, close, read, readLines } from './file';

/**
 * Read the first N bytes from a file descriptor.
 * Stops reading as soon as the limit is reached.
 *
 * @param fd - File descriptor to read from
 * @param size - Maximum bytes to read
 * @returns Buffer containing at most `size` bytes
 */
export async function head(fd: number, size: number): Promise<Uint8Array> {
    if (size <= 0) {
        return new Uint8Array(0);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of read(fd)) {
        if (total + chunk.length >= size) {
            // Take only what we need from this chunk
            chunks.push(chunk.slice(0, size - total));
            total = size;
            break;
        }

        chunks.push(chunk);
        total += chunk.length;
    }

    // Fast path: single chunk or no data
    if (chunks.length <= 1) {
        return chunks[0] ?? new Uint8Array(0);
    }

    // Concatenate chunks
    const result = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return result;
}

/**
 * Read the first N lines from a file descriptor.
 * Yields lines without trailing newlines.
 *
 * @param fd - File descriptor to read from
 * @param count - Maximum number of lines to read
 */
export async function* headLines(fd: number, count: number): AsyncIterable<string> {
    if (count <= 0) {
        return;
    }

    let n = 0;

    for await (const line of readLines(fd)) {
        yield line;
        n++;
        if (n >= count) {
            break;
        }
    }
}

/**
 * Read the first N bytes from a file path.
 * Opens, reads, and closes the file.
 *
 * @param path - File path
 * @param size - Maximum bytes to read
 */
export async function headFile(path: string, size: number): Promise<Uint8Array> {
    const fd = await open(path, { read: true });

    try {
        return await head(fd, size);
    }
    finally {
        await close(fd);
    }
}

/**
 * Read the first N lines from a file path.
 * Opens, reads, and closes the file.
 *
 * @param path - File path
 * @param count - Maximum number of lines to read
 */
export async function headFileLines(path: string, count: number): Promise<string[]> {
    const fd = await open(path, { read: true });

    try {
        const lines: string[] = [];

        for await (const line of headLines(fd, count)) {
            lines.push(line);
        }

        return lines;
    }
    finally {
        await close(fd);
    }
}
