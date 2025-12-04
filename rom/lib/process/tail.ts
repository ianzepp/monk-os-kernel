/**
 * Tail operations for VFS scripts.
 * Read the end of files efficiently.
 */

import { open, close, readAll, readLines, seek, fstat } from './file';

/**
 * Read the last N bytes from a seekable file descriptor.
 * Uses seek to efficiently read only the tail.
 *
 * @param fd - File descriptor to read from (must be seekable)
 * @param size - Maximum bytes to read from the end
 * @returns Buffer containing at most `size` bytes
 */
export async function tail(fd: number, size: number): Promise<Uint8Array> {
    if (size <= 0) {
        return new Uint8Array(0);
    }

    // Get file size
    const st = await fstat(fd);
    const fileSize = st.size;

    if (fileSize === 0) {
        return new Uint8Array(0);
    }

    // Seek to position
    const seekPos = Math.max(0, fileSize - size);
    await seek(fd, seekPos, 'start');

    // Read remaining
    return readAll(fd, size);
}

/**
 * Read the last N lines from a file descriptor.
 * Must read entire file to find line boundaries.
 *
 * @param fd - File descriptor to read from
 * @param count - Maximum number of lines to return
 */
export async function tailLines(fd: number, count: number): Promise<string[]> {
    if (count <= 0) {
        return [];
    }

    // Use a circular buffer to keep only the last N lines
    const buffer: string[] = [];
    let writeIndex = 0;
    let filled = false;

    for await (const line of readLines(fd)) {
        if (buffer.length < count) {
            buffer.push(line);
        } else {
            buffer[writeIndex] = line;
            writeIndex = (writeIndex + 1) % count;
            filled = true;
        }
    }

    if (!filled) {
        return buffer;
    }

    // Reorder circular buffer to linear array
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
        const item = buffer[(writeIndex + i) % count];
        if (item !== undefined) {
            result.push(item);
        }
    }
    return result;
}

/**
 * Read the last N bytes from a file path.
 * Opens, reads, and closes the file.
 *
 * @param path - File path
 * @param size - Maximum bytes to read from the end
 */
export async function tailFile(path: string, size: number): Promise<Uint8Array> {
    const fd = await open(path, { read: true });
    try {
        return await tail(fd, size);
    } finally {
        await close(fd);
    }
}

/**
 * Read the last N lines from a file path.
 * Opens, reads, and closes the file.
 *
 * @param path - File path
 * @param count - Maximum number of lines to return
 */
export async function tailFileLines(path: string, count: number): Promise<string[]> {
    const fd = await open(path, { read: true });
    try {
        return await tailLines(fd, count);
    } finally {
        await close(fd);
    }
}
