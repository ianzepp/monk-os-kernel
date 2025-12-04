/**
 * Directory operations for VFS scripts.
 */

import type { MkdirOpts } from './types';
import { SyscallError } from './error';
import { call, iterate } from './syscall';

const DEFAULT_MAX_ENTRIES = 10_000; // 10k directory entries

export function mkdir(path: string, opts?: MkdirOpts): Promise<void> {
    return call<void>('mkdir', path, opts);
}

export function unlink(path: string): Promise<void> {
    return call<void>('unlink', path);
}

export function rmdir(path: string): Promise<void> {
    return call<void>('rmdir', path);
}

/**
 * Stream directory entries.
 */
export function readdir(path: string): AsyncIterable<string> {
    return iterate<string>('readdir', path);
}

/**
 * Read all directory entries into an array.
 *
 * @param path - Directory path
 * @param maxEntries - Maximum entries to read (default 10k, kernel limit 100k)
 */
export async function readdirAll(path: string, maxEntries: number = DEFAULT_MAX_ENTRIES): Promise<string[]> {
    const entries: string[] = [];
    for await (const entry of readdir(path)) {
        if (entries.length >= maxEntries) {
            throw new SyscallError('EFBIG', `Directory listing exceeded ${maxEntries} entries`);
        }
        entries.push(entry);
    }
    return entries;
}

export function rename(oldPath: string, newPath: string): Promise<void> {
    return call<void>('rename', oldPath, newPath);
}

export function symlink(target: string, linkPath: string): Promise<void> {
    return call<void>('symlink', target, linkPath);
}
