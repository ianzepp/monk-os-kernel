/**
 * Convenience I/O functions for VFS scripts.
 */

import { open, close, read, readAll, readText, write } from './file';
import { send } from './pipe';
import { respond } from './types';

const DEFAULT_MAX_READ = 10 * 1024 * 1024; // 10MB

/**
 * Read entire file as string. Opens, reads, and closes.
 *
 * @param path - File path
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readFile(path: string, maxSize: number = DEFAULT_MAX_READ): Promise<string> {
    const fd = await open(path, { read: true });

    try {
        return await readText(fd, maxSize);
    }
    finally {
        await close(fd);
    }
}

/**
 * Read entire file as bytes. Opens, reads, and closes.
 *
 * @param path - File path
 * @param maxSize - Maximum bytes to read (default 10MB, kernel limit 100MB)
 */
export async function readFileBytes(path: string, maxSize: number = DEFAULT_MAX_READ): Promise<Uint8Array> {
    const fd = await open(path, { read: true });

    try {
        return await readAll(fd, maxSize);
    }
    finally {
        await close(fd);
    }
}

/**
 * Write string to file. Opens, writes, and closes.
 */
export async function writeFile(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, truncate: true });

    try {
        await write(fd, new TextEncoder().encode(content));
    }
    finally {
        await close(fd);
    }
}

/**
 * Copy data from one file descriptor to another.
 * Streams chunks to avoid memory issues with large files.
 *
 * @returns Total bytes copied
 */
export async function copy(srcFd: number, dstFd: number): Promise<number> {
    let total = 0;

    for await (const chunk of read(srcFd)) {
        await write(dstFd, chunk);
        total += chunk.length;
    }

    return total;
}

/**
 * Copy a file from source path to destination path.
 * Opens both files, copies data, and closes both.
 *
 * @returns Total bytes copied
 */
export async function copyFile(srcPath: string, dstPath: string): Promise<number> {
    const src = await open(srcPath, { read: true });

    try {
        const dst = await open(dstPath, { write: true, create: true, truncate: true });

        try {
            return await copy(src, dst);
        }
        finally {
            await close(dst);
        }
    }
    finally {
        await close(src);
    }
}

export async function print(text: string): Promise<void> {
    await send(1, respond.item({ text }));
}

export async function println(text: string): Promise<void> {
    await send(1, respond.item({ text: text + '\n' }));
}

export async function eprint(text: string): Promise<void> {
    await send(2, respond.item({ text }));
}

export async function eprintln(text: string): Promise<void> {
    await send(2, respond.item({ text: text + '\n' }));
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
