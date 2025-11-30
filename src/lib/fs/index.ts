/**
 * Filesystem (FS)
 *
 * Provides a unified filesystem abstraction over:
 * - Database-backed storage (fs table)
 * - API endpoints as virtual directories (/api/data, /api/describe, etc.)
 * - System introspection (/system)
 *
 * Each FS instance is bound to an authenticated session (System context).
 */

import type { System } from '@src/lib/system.js';
import type { Mount, FSEntry, ResolvedPath } from './types.js';
import { FSError } from './types.js';

export { FSError } from './types.js';
export type { FSEntry, FSEntryType, FSErrorCode, Mount, ResolvedPath } from './types.js';
export { DatabaseMount, ModelBackedStorage } from './mounts/database-mount.js';
export { initializeFS } from './init.js';
export { LocalMount } from './mounts/local-mount.js';
export { MemoryMountRegistry, UserTmpRegistry } from './mounts/memory-mount.js';
export type { LocalMountOptions } from './mounts/local-mount.js';

/**
 * Filesystem class
 *
 * Routes filesystem operations to appropriate mount handlers based on path.
 * Mounts are matched by longest-prefix matching (most specific wins).
 *
 * System context is optional - required only for mounts that need database access.
 * A base FS with static mounts (LocalMount to monkfs/) can exist without System.
 */
export class FS {
    private mounts: Map<string, Mount> = new Map();
    private sortedMounts: [string, Mount][] = [];
    private fallback: Mount | null = null;

    /**
     * Create a new filesystem instance
     * @param system - Optional authenticated system context (required for database-backed mounts)
     */
    constructor(public readonly system?: System) {}

    /**
     * Mount a handler at a path
     *
     * The parent directory of the mount point must exist in the filesystem.
     * For example, to mount at "/api/data", the "/api" directory must exist.
     *
     * @param path - Mount point (e.g., "/api/data")
     * @param handler - Mount implementation
     */
    mount(path: string, handler: Mount): void {
        const normalized = this.normalize(path);
        this.mounts.set(normalized, handler);
        this.sortedMounts = [...this.mounts.entries()]
            .sort((a, b) => b[0].length - a[0].length);
    }

    /**
     * Unmount a handler
     */
    unmount(path: string): void {
        const normalized = this.normalize(path);
        this.mounts.delete(normalized);
        this.sortedMounts = [...this.mounts.entries()]
            .sort((a, b) => b[0].length - a[0].length);
    }

    /**
     * Set fallback handler for unmatched paths
     */
    setFallback(handler: Mount): void {
        this.fallback = handler;
    }

    /**
     * Get all registered mounts
     */
    getMounts(): Map<string, Mount> {
        return new Map(this.mounts);
    }

    /**
     * Get the fallback mount handler
     */
    getFallback(): Mount | null {
        return this.fallback;
    }

    /**
     * Resolve a path to its mount handler
     */
    private resolvePath(path: string): ResolvedPath {
        const normalized = this.normalize(path);

        for (const [mountPath, handler] of this.sortedMounts) {
            // Root mount matches everything - check last (it's sorted last by length)
            if (mountPath === '/') {
                return {
                    handler,
                    relativePath: normalized,
                    mountPath: '/',
                };
            }

            if (normalized === mountPath || normalized.startsWith(mountPath + '/')) {
                return {
                    handler,
                    relativePath: normalized.slice(mountPath.length) || '/',
                    mountPath,
                };
            }
        }

        if (this.fallback) {
            return {
                handler: this.fallback,
                relativePath: normalized,
                mountPath: '/',
            };
        }

        throw new FSError('ENOENT', path);
    }

    /**
     * Get file/directory metadata
     */
    async stat(path: string): Promise<FSEntry> {
        const { handler, relativePath } = this.resolvePath(path);
        return handler.stat(relativePath);
    }

    /**
     * List directory contents
     *
     * Includes mount points that appear at the listed directory level.
     */
    async readdir(path: string): Promise<FSEntry[]> {
        const normalized = this.normalize(path);
        const { handler, relativePath } = this.resolvePath(path);
        const entries = await handler.readdir(relativePath);

        // Inject mount points that appear at this level
        for (const [mountPath] of this.sortedMounts) {
            // Skip root mount - it's not a subdirectory entry
            if (mountPath === '/') continue;

            const mountParent = this.dirname(mountPath);
            if (mountParent === normalized) {
                const mountName = this.basename(mountPath);
                if (!entries.some(e => e.name === mountName)) {
                    entries.push({
                        name: mountName,
                        type: 'directory',
                        size: 0,
                        mode: 0o755,
                    });
                }
            }
        }

        return entries;
    }

    /**
     * Read file contents
     */
    async read(path: string): Promise<string | Buffer> {
        const { handler, relativePath } = this.resolvePath(path);
        return handler.read(relativePath);
    }

    /**
     * Write file contents
     */
    async write(path: string, content: string | Buffer): Promise<void> {
        const { handler, relativePath } = this.resolvePath(path);
        if (!handler.write) {
            throw new FSError('EROFS', path, 'Read-only filesystem');
        }
        return handler.write(relativePath, content);
    }

    /**
     * Delete a file
     */
    async unlink(path: string): Promise<void> {
        const { handler, relativePath } = this.resolvePath(path);
        if (!handler.unlink) {
            throw new FSError('EROFS', path, 'Read-only filesystem');
        }
        return handler.unlink(relativePath);
    }

    /**
     * Create a directory
     */
    async mkdir(path: string, mode = 0o755): Promise<void> {
        const { handler, relativePath } = this.resolvePath(path);
        if (!handler.mkdir) {
            throw new FSError('EROFS', path, 'Read-only filesystem');
        }
        return handler.mkdir(relativePath, mode);
    }

    /**
     * Remove a directory
     */
    async rmdir(path: string): Promise<void> {
        const { handler, relativePath } = this.resolvePath(path);
        if (!handler.rmdir) {
            throw new FSError('EROFS', path, 'Read-only filesystem');
        }
        return handler.rmdir(relativePath);
    }

    /**
     * Rename/move a file or directory
     */
    async rename(oldPath: string, newPath: string): Promise<void> {
        const oldResolved = this.resolvePath(oldPath);
        const newResolved = this.resolvePath(newPath);

        // Cross-mount rename not supported
        if (oldResolved.mountPath !== newResolved.mountPath) {
            throw new FSError('EINVAL', oldPath, 'Cannot rename across mount points');
        }

        if (!oldResolved.handler.rename) {
            throw new FSError('EROFS', oldPath, 'Read-only filesystem');
        }
        return oldResolved.handler.rename(oldResolved.relativePath, newResolved.relativePath);
    }

    /**
     * Create a symbolic link
     */
    async symlink(target: string, path: string): Promise<void> {
        const { handler, relativePath } = this.resolvePath(path);
        if (!handler.symlink) {
            throw new FSError('EROFS', path, 'Symbolic links not supported');
        }
        return handler.symlink(target, relativePath);
    }

    /**
     * Read symbolic link target
     */
    async readlink(path: string): Promise<string> {
        const { handler, relativePath } = this.resolvePath(path);
        if (!handler.readlink) {
            throw new FSError('EINVAL', path, 'Not a symbolic link');
        }
        return handler.readlink(relativePath);
    }

    /**
     * Change file permissions
     */
    async chmod(path: string, mode: number): Promise<void> {
        const { handler, relativePath } = this.resolvePath(path);
        if (!handler.chmod) {
            throw new FSError('EROFS', path, 'Read-only file system');
        }
        return handler.chmod(relativePath, mode);
    }

    /**
     * Check if a path exists
     */
    async exists(path: string): Promise<boolean> {
        try {
            await this.stat(path);
            return true;
        } catch (err) {
            if (err instanceof FSError && err.code === 'ENOENT') {
                return false;
            }
            throw err;
        }
    }

    /**
     * Get entry type only (lightweight, may avoid I/O)
     *
     * Uses mount's getType() if available (no I/O), otherwise falls back to stat().
     * Returns null if path doesn't exist.
     */
    async statType(path: string): Promise<'file' | 'directory' | 'symlink' | null> {
        const { handler, relativePath } = this.resolvePath(path);

        // Try lightweight getType first (no I/O)
        if (handler.getType) {
            const type = handler.getType(relativePath);
            if (type !== null) {
                return type;
            }
        }

        // Fall back to full stat
        try {
            const entry = await handler.stat(relativePath);
            return entry.type;
        } catch (err) {
            if (err instanceof FSError && err.code === 'ENOENT') {
                return null;
            }
            throw err;
        }
    }

    /**
     * Check if path is a file
     */
    async isFile(path: string): Promise<boolean> {
        const type = await this.statType(path);
        return type === 'file';
    }

    /**
     * Check if path is a directory
     */
    async isDirectory(path: string): Promise<boolean> {
        const type = await this.statType(path);
        return type === 'directory';
    }

    /**
     * Resolve path segments to an absolute path
     *
     * @param base - Base path (usually cwd)
     * @param paths - Path segments to resolve
     * @returns Absolute normalized path
     */
    resolve(base: string, ...paths: string[]): string {
        let result = base;

        for (const p of paths) {
            if (p.startsWith('/')) {
                result = p;
            } else {
                result = result + '/' + p;
            }
        }

        return this.normalize(result);
    }

    /**
     * Normalize a path (remove . and .., collapse slashes)
     */
    normalize(path: string): string {
        const parts = path.split('/').filter(p => p && p !== '.');
        const result: string[] = [];

        for (const part of parts) {
            if (part === '..') {
                result.pop();
            } else {
                result.push(part);
            }
        }

        return '/' + result.join('/');
    }

    /**
     * Get parent directory path
     */
    dirname(path: string): string {
        const normalized = this.normalize(path);
        const parts = normalized.split('/').filter(Boolean);
        parts.pop();
        return '/' + parts.join('/');
    }

    /**
     * Get filename from path
     */
    basename(path: string): string {
        const normalized = this.normalize(path);
        return normalized.split('/').filter(Boolean).pop() || '';
    }

    /**
     * Get file extension
     */
    extname(path: string): string {
        const name = this.basename(path);
        const dot = name.lastIndexOf('.');
        return dot > 0 ? name.slice(dot) : '';
    }
}
