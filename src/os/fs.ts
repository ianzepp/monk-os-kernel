/**
 * Filesystem API
 *
 * Provides file operations for the OS public API.
 */

import type { VFS } from '@src/vfs/vfs.js';
import type { ModelStat } from '@src/vfs/model.js';
import type { MountOpts, Stat } from './types.js';
import { EINVAL } from '@src/hal/errors.js';

/**
 * Interface for OS methods needed by FilesystemAPI.
 * Avoids circular dependency with OS class.
 */
export interface FilesystemAPIHost {
    getVFS(): VFS;
    resolvePath(path: string): string;
    isBooted(): boolean;
}

/**
 * Filesystem API for OS
 *
 * Provides file operations with automatic alias resolution.
 * All operations use 'kernel' as the caller for access control.
 */
export class FilesystemAPI {
    private host: FilesystemAPIHost;

    constructor(host: FilesystemAPIHost) {
        this.host = host;
    }

    /**
     * Mount a host directory into the OS filesystem.
     *
     * @param hostPath - Path on the host filesystem
     * @param osPath - Path inside the OS (aliases resolved)
     * @param opts - Mount options
     * @throws EINVAL if called before boot()
     */
    mount(hostPath: string, osPath: string, opts?: MountOpts): void {
        if (!this.host.isBooted()) {
            throw new EINVAL('Cannot call fs.mount() before boot()');
        }

        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(osPath);

        vfs.mountHost(resolvedPath, hostPath, {
            readonly: opts?.readonly,
        });
    }

    /**
     * Unmount a host directory.
     *
     * @param osPath - Path inside the OS (aliases resolved)
     */
    unmount(osPath: string): void {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(osPath);

        vfs.unmountHost(resolvedPath);
    }

    /**
     * Read a file's contents.
     *
     * @param path - Path to file (aliases resolved)
     * @returns File contents as Uint8Array
     */
    async read(path: string): Promise<Uint8Array> {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(path);
        const handle = await vfs.open(resolvedPath, { read: true }, 'kernel');

        try {
            // Read entire file - get size from stat first
            const stat = await vfs.stat(resolvedPath, 'kernel');

            return await handle.read(stat.size || 4096);
        }
        finally {
            await handle.close();
        }
    }

    /**
     * Read a file as text.
     *
     * @param path - Path to file (aliases resolved)
     * @returns File contents as string
     */
    async readText(path: string): Promise<string> {
        const data = await this.read(path);

        return new TextDecoder().decode(data);
    }

    /**
     * Write data to a file.
     *
     * @param path - Path to file (aliases resolved)
     * @param data - Data to write
     */
    async write(path: string, data: Uint8Array | string): Promise<void> {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(path);
        const bytes = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;
        const handle = await vfs.open(resolvedPath, { write: true, create: true, truncate: true }, 'kernel');

        try {
            await handle.write(bytes);
        }
        finally {
            await handle.close();
        }
    }

    /**
     * Get file or directory information.
     *
     * @param path - Path to stat (aliases resolved)
     * @returns Stat information
     */
    async stat(path: string): Promise<Stat> {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(path);
        const modelStat = await vfs.stat(resolvedPath, 'kernel');

        return this.toStat(modelStat);
    }

    /**
     * List directory contents.
     *
     * @param path - Path to directory (aliases resolved)
     * @returns Array of entry names
     */
    async readdir(path: string): Promise<string[]> {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(path);
        const names: string[] = [];

        for await (const entry of vfs.readdir(resolvedPath, 'kernel')) {
            names.push(entry.name);
        }

        return names;
    }

    /**
     * List directory contents with full stat info.
     *
     * @param path - Path to directory (aliases resolved)
     * @returns Array of Stat objects
     */
    async readdirStat(path: string): Promise<Stat[]> {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(path);
        const stats: Stat[] = [];

        for await (const entry of vfs.readdir(resolvedPath, 'kernel')) {
            stats.push(this.toStat(entry));
        }

        return stats;
    }

    /**
     * Create a directory.
     *
     * @param path - Path to create (aliases resolved)
     * @param opts - Options (recursive: create parent dirs)
     */
    async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(path);

        await vfs.mkdir(resolvedPath, 'kernel', opts);
    }

    /**
     * Delete a file or empty directory.
     *
     * @param path - Path to delete (aliases resolved)
     */
    async unlink(path: string): Promise<void> {
        const vfs = this.host.getVFS();
        const resolvedPath = this.host.resolvePath(path);

        await vfs.unlink(resolvedPath, 'kernel');
    }

    /**
     * Check if a path exists.
     *
     * @param path - Path to check (aliases resolved)
     * @returns true if exists
     */
    async exists(path: string): Promise<boolean> {
        try {
            await this.stat(path);

            return true;
        }
        catch {
            return false;
        }
    }

    /**
     * Convert ModelStat to public Stat interface.
     */
    private toStat(modelStat: ModelStat): Stat {
        return {
            id: modelStat.id,
            type: modelStat.model as 'file' | 'folder' | 'device' | 'link',
            name: modelStat.name,
            size: modelStat.size,
            mtime: modelStat.mtime,
            ctime: modelStat.ctime,
        };
    }
}
