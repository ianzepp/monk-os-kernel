/**
 * Host Mount
 *
 * Maps a VFS path prefix to a directory on the host filesystem.
 * Used to expose host directories (like ./src/bin/) into the VFS.
 *
 * Example:
 *   vfs.mountHost('/bin', './src/bin', { readonly: true });
 *   // Now /bin/init.ts reads from ./src/bin/init.ts
 */

import { readFile, stat as fsStat, readdir } from 'fs/promises';
import { join, resolve, basename } from 'path';
import type { FileHandle, OpenFlags, SeekWhence } from '@src/vfs/handle.js';
import type { ModelStat } from '@src/vfs/model.js';
import { ENOENT, EACCES, EISDIR, ENOTDIR } from '@src/hal/errors.js';

/**
 * Host mount options
 */
export interface HostMountOptions {
    /** Mount as read-only (default: true for safety) */
    readonly?: boolean;
}

/**
 * Host mount configuration
 */
export interface HostMount {
    /** VFS path prefix (e.g., '/bin') */
    vfsPath: string;

    /** Host directory path (e.g., './src/bin') */
    hostPath: string;

    /** Resolved absolute host path */
    resolvedHostPath: string;

    /** Mount options */
    options: HostMountOptions;
}

/**
 * Create a host mount configuration.
 */
export function createHostMount(vfsPath: string, hostPath: string, options: HostMountOptions = {}): HostMount {
    // Normalize VFS path
    const normalizedVfsPath = vfsPath.replace(/\/+$/, '') || '/';

    // Resolve host path to absolute
    const resolvedHostPath = resolve(hostPath);

    return {
        vfsPath: normalizedVfsPath,
        hostPath,
        resolvedHostPath,
        options: {
            readonly: options.readonly ?? true,
        },
    };
}

/**
 * Resolve a VFS path to a host path using the mount.
 *
 * @returns Host path if path is under this mount, null otherwise
 */
export function resolveHostPath(mount: HostMount, vfsPath: string): string | null {
    // Check if path is under this mount
    if (vfsPath === mount.vfsPath) {
        return mount.resolvedHostPath;
    }

    if (vfsPath.startsWith(mount.vfsPath + '/')) {
        const relativePath = vfsPath.slice(mount.vfsPath.length);
        const hostPath = join(mount.resolvedHostPath, relativePath);

        // Security: ensure resolved path is still under the mount
        const resolved = resolve(hostPath);
        if (!resolved.startsWith(mount.resolvedHostPath)) {
            return null; // Path traversal attempt
        }

        return resolved;
    }

    return null;
}

/**
 * Check if a VFS path is under a host mount.
 */
export function isUnderHostMount(mount: HostMount, vfsPath: string): boolean {
    return vfsPath === mount.vfsPath || vfsPath.startsWith(mount.vfsPath + '/');
}

/**
 * Stat a path on the host filesystem.
 */
export async function hostStat(mount: HostMount, vfsPath: string): Promise<ModelStat> {
    const hostPath = resolveHostPath(mount, vfsPath);
    if (!hostPath) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    try {
        const stats = await fsStat(hostPath);
        const name = basename(vfsPath) || basename(mount.vfsPath);

        return {
            id: `host:${vfsPath}`, // Synthetic ID for host files
            model: stats.isDirectory() ? 'folder' : 'file',
            name,
            parent: null, // Host files don't have VFS parent tracking
            owner: 'kernel',
            size: stats.size,
            mtime: stats.mtimeMs,
            ctime: stats.ctimeMs,
        };
    } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
            throw new ENOENT(`No such file: ${vfsPath}`);
        }
        throw err;
    }
}

/**
 * Read directory from host filesystem.
 */
export async function* hostReaddir(mount: HostMount, vfsPath: string): AsyncIterable<ModelStat> {
    const hostPath = resolveHostPath(mount, vfsPath);
    if (!hostPath) {
        throw new ENOENT(`No such directory: ${vfsPath}`);
    }

    try {
        const entries = await readdir(hostPath, { withFileTypes: true });

        for (const entry of entries) {
            const entryVfsPath = vfsPath === '/' ? `/${entry.name}` : `${vfsPath}/${entry.name}`;
            const entryHostPath = join(hostPath, entry.name);

            try {
                const stats = await fsStat(entryHostPath);

                yield {
                    id: `host:${entryVfsPath}`,
                    model: entry.isDirectory() ? 'folder' : 'file',
                    name: entry.name,
                    parent: null,
                    owner: 'kernel',
                    size: stats.size,
                    mtime: stats.mtimeMs,
                    ctime: stats.ctimeMs,
                };
            } catch {
                // Skip entries we can't stat
            }
        }
    } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
            throw new ENOENT(`No such directory: ${vfsPath}`);
        }
        if (error.code === 'ENOTDIR') {
            throw new ENOTDIR(`Not a directory: ${vfsPath}`);
        }
        throw err;
    }
}

/**
 * Open a file from host filesystem.
 */
export async function hostOpen(
    mount: HostMount,
    vfsPath: string,
    flags: OpenFlags
): Promise<FileHandle> {
    const hostPath = resolveHostPath(mount, vfsPath);
    if (!hostPath) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    // Check write permission
    if (flags.write && mount.options.readonly) {
        throw new EACCES(`Mount is read-only: ${vfsPath}`);
    }

    // Check if file exists and is not a directory
    try {
        const stats = await fsStat(hostPath);
        if (stats.isDirectory()) {
            throw new EISDIR(`Is a directory: ${vfsPath}`);
        }
    } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
            if (!flags.create) {
                throw new ENOENT(`No such file: ${vfsPath}`);
            }
            // Will create on first write (not implemented for readonly mounts)
            if (mount.options.readonly) {
                throw new EACCES(`Mount is read-only: ${vfsPath}`);
            }
        } else if (!(err instanceof EISDIR)) {
            throw err;
        } else {
            throw err;
        }
    }

    return new HostFileHandle(hostPath, vfsPath, flags);
}

/**
 * FileHandle implementation for host filesystem files.
 */
class HostFileHandle implements FileHandle {
    readonly id: string;
    readonly path: string;
    readonly flags: OpenFlags;

    private _closed = false;
    private _position = 0;
    private _content: Uint8Array | null = null;
    private readonly hostPath: string;

    constructor(hostPath: string, vfsPath: string, flags: OpenFlags) {
        this.hostPath = hostPath;
        this.id = `host-handle:${vfsPath}:${Date.now()}`;
        this.path = vfsPath;
        this.flags = flags;
    }

    get closed(): boolean {
        return this._closed;
    }

    async read(size?: number): Promise<Uint8Array> {
        if (this._closed) {
            throw new Error('Handle is closed');
        }

        if (!this.flags.read) {
            throw new EACCES('Not opened for reading');
        }

        // Lazy load content
        if (this._content === null) {
            const buffer = await readFile(this.hostPath);
            this._content = new Uint8Array(buffer);
        }

        const remaining = this._content.length - this._position;
        if (remaining <= 0) {
            return new Uint8Array(0);
        }

        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;
        const result = this._content.slice(this._position, this._position + toRead);
        this._position += toRead;

        return result;
    }

    async write(_data: Uint8Array): Promise<number> {
        if (this._closed) {
            throw new Error('Handle is closed');
        }

        if (!this.flags.write) {
            throw new EACCES('Not opened for writing');
        }

        // Host mounts are typically read-only for now
        throw new EACCES('Host mount write not implemented');
    }

    async seek(offset: number, whence: SeekWhence): Promise<number> {
        if (this._closed) {
            throw new Error('Handle is closed');
        }

        // Load content to know size
        if (this._content === null) {
            const buffer = await readFile(this.hostPath);
            this._content = new Uint8Array(buffer);
        }

        let newPosition: number;

        switch (whence) {
            case 'start':
                newPosition = offset;
                break;
            case 'current':
                newPosition = this._position + offset;
                break;
            case 'end':
                newPosition = this._content.length + offset;
                break;
        }

        if (newPosition < 0) {
            newPosition = 0;
        }

        this._position = newPosition;
        return this._position;
    }

    async tell(): Promise<number> {
        return this._position;
    }

    async sync(): Promise<void> {
        // No-op for read-only host files
    }

    async close(): Promise<void> {
        this._closed = true;
        this._content = null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}
