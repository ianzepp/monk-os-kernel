/**
 * File operations for VFS scripts.
 */

import type { OpenFlags, SeekWhence, Stat } from './types';
import { SyscallError } from './error';
import { call, iterate } from './syscall';

const DEFAULT_MAX_READ = 10 * 1024 * 1024; // 10MB

export function open(path: string, flags?: OpenFlags): Promise<number> {
    return call<number>('file:open', path, flags ?? { read: true });
}

export function close(fd: number): Promise<void> {
    return call<void>('file:close', fd);
}

/**
 * Stream chunks from a file descriptor until EOF.
 *
 * @param fd - File descriptor to read from
 * @param chunkSize - Optional hint for chunk size (kernel may ignore)
 */
export function read(fd: number, chunkSize?: number): AsyncIterable<Uint8Array> {
    return iterate<Uint8Array>('file:read', fd, chunkSize);
}

/**
 * Read entire file descriptor contents into a single buffer.
 *
 * @param fd - File descriptor to read from
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readAll(fd: number, maxSize: number = DEFAULT_MAX_READ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of read(fd)) {
        total += chunk.length;
        if (total > maxSize) {
            throw new SyscallError('EFBIG', `Read exceeded ${maxSize} bytes`);
        }

        chunks.push(chunk);
    }

    // Fast path: single chunk
    if (chunks.length === 1) {
        const firstChunk = chunks[0];

        if (firstChunk !== undefined) {
            return firstChunk;
        }
    }

    // Fast path: no data
    if (chunks.length === 0) {
        return new Uint8Array(0);
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
 * Stream lines from a text file.
 * Each yielded string is one line without the newline character.
 */
export async function* readLines(fd: number): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of read(fd)) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');

        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
            yield line;
        }
    }

    // Flush remaining buffer (file without trailing newline)
    buffer += decoder.decode(); // Flush decoder
    if (buffer) {
        yield buffer;
    }
}

/**
 * Read entire file descriptor contents as a string.
 *
 * @param fd - File descriptor to read from
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readText(fd: number, maxSize: number = DEFAULT_MAX_READ): Promise<string> {
    const data = await readAll(fd, maxSize);

    return new TextDecoder().decode(data);
}

export function write(fd: number, data: Uint8Array): Promise<number> {
    return call<number>('file:write', fd, data);
}

export function seek(fd: number, offset: number, whence?: SeekWhence): Promise<number> {
    return call<number>('file:seek', fd, offset, whence ?? 'start');
}

export function stat(path: string): Promise<Stat> {
    return call<Stat>('file:stat', path);
}

export function fstat(fd: number): Promise<Stat> {
    return call<Stat>('file:fstat', fd);
}
