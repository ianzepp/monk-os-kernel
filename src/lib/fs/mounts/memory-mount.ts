/**
 * MemoryMount - In-memory filesystem for root (/)
 *
 * Provides a fast, ephemeral filesystem that exists only in memory.
 * All data is lost on server restart - ideal for system directories.
 *
 * Features:
 * - Full read/write support
 * - Directories, files, and symlinks
 * - No persistence (intentionally)
 * - Per-tenant isolation via MemoryMountRegistry
 * - Size limits: 500MB per tenant, 50MB per file
 *
 * Lifecycle:
 * - Created once per tenant, persists for server lifetime
 * - Shared across all users/sessions within a tenant
 * - Use MemoryMountRegistry.get(tenant) to obtain the shared instance
 *
 * Note: User home directories (/home/{user}) are mounted separately
 * with DatabaseMount for persistence.
 */

import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';

/** Maximum total size per tenant (500 MB) */
const MAX_TENANT_SIZE = 500 * 1024 * 1024;

/** Maximum size per file (50 MB) */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

interface MemoryNode {
    name: string;
    type: 'file' | 'directory' | 'symlink';
    content: Buffer;
    target: string | null;
    mode: number;
    uid: string;
    mtime: Date;
    ctime: Date;
    children: Map<string, MemoryNode>;
}

/**
 * Registry of per-tenant root mounts
 *
 * Ensures each tenant gets a single shared MemoryMount instance
 * that persists for the lifetime of the server process.
 */
export class MemoryMountRegistry {
    private static mounts = new Map<string, MemoryMount>();

    /**
     * Get or create the root mount for a tenant
     */
    static get(tenant: string): MemoryMount {
        let mount = this.mounts.get(tenant);
        if (!mount) {
            mount = new MemoryMount();
            this.mounts.set(tenant, mount);
        }
        return mount;
    }

    /**
     * Clear all mounts (for testing)
     */
    static clear(): void {
        this.mounts.clear();
    }

    /**
     * Remove a specific tenant's mount (for tenant deletion)
     */
    static remove(tenant: string): void {
        this.mounts.delete(tenant);
    }
}

/**
 * Registry of per-user tmp mounts
 *
 * Ensures each user gets their own isolated /tmp that:
 * - Persists across their sessions (two terminals = same /tmp)
 * - Is isolated from other users in the same tenant
 * - Lives for the server lifetime (or until explicitly cleared)
 */
export class UserTmpRegistry {
    private static mounts = new Map<string, MemoryMount>();

    /**
     * Get or create the /tmp mount for a specific user
     */
    static get(tenant: string, username: string): MemoryMount {
        const key = `${tenant}:${username}`;
        let mount = this.mounts.get(key);
        if (!mount) {
            mount = new MemoryMount();
            this.mounts.set(key, mount);
        }
        return mount;
    }

    /**
     * Clear all user tmp mounts (for testing)
     */
    static clear(): void {
        this.mounts.clear();
    }

    /**
     * Remove a specific user's tmp mount (for user logout cleanup)
     */
    static remove(tenant: string, username: string): void {
        const key = `${tenant}:${username}`;
        this.mounts.delete(key);
    }

    /**
     * Remove all tmp mounts for a tenant (for tenant deletion)
     */
    static removeTenant(tenant: string): void {
        const prefix = `${tenant}:`;
        for (const key of this.mounts.keys()) {
            if (key.startsWith(prefix)) {
                this.mounts.delete(key);
            }
        }
    }
}

/** @deprecated Use MemoryMountRegistry instead */
export const TmpMountRegistry = MemoryMountRegistry;

export class MemoryMount implements Mount {
    private root: MemoryNode;
    private totalSize = 0;

    constructor() {
        this.root = this.createDir('', 0o1777); // sticky bit for /tmp
    }

    /**
     * Get current total size in bytes
     */
    getTotalSize(): number {
        return this.totalSize;
    }

    /**
     * Get available space in bytes
     */
    getAvailableSpace(): number {
        return MAX_TENANT_SIZE - this.totalSize;
    }

    async stat(path: string): Promise<FSEntry> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        return this.toEntry(node);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.type !== 'directory') {
            throw new FSError('ENOTDIR', path);
        }
        return Array.from(node.children.values()).map(child => this.toEntry(child));
    }

    async read(path: string): Promise<string | Buffer> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.type === 'directory') {
            throw new FSError('EISDIR', path);
        }
        if (node.type === 'symlink') {
            if (!node.target) {
                throw new FSError('EINVAL', path, 'Symlink has no target');
            }
            return this.read(node.target);
        }
        return node.content;
    }

    async write(path: string, content: string | Buffer): Promise<void> {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

        // Check per-file limit
        if (buffer.length > MAX_FILE_SIZE) {
            throw new FSError('ENOSPC', path, `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
        }

        const existing = this.getNode(path);

        if (existing) {
            if (existing.type === 'directory') {
                throw new FSError('EISDIR', path);
            }
            // Calculate size delta
            const delta = buffer.length - existing.content.length;
            if (delta > 0 && this.totalSize + delta > MAX_TENANT_SIZE) {
                throw new FSError('ENOSPC', path, 'No space left on device');
            }
            this.totalSize += delta;
            existing.content = buffer;
            existing.mtime = new Date();
        } else {
            // Check tenant quota for new file
            if (this.totalSize + buffer.length > MAX_TENANT_SIZE) {
                throw new FSError('ENOSPC', path, 'No space left on device');
            }

            const parentPath = this.dirname(path);
            const parent = this.getNode(parentPath);
            if (!parent) {
                throw new FSError('ENOENT', parentPath);
            }
            if (parent.type !== 'directory') {
                throw new FSError('ENOTDIR', parentPath);
            }

            const name = this.basename(path);
            const node = this.createFile(name, buffer);
            parent.children.set(name, node);
            this.totalSize += buffer.length;
        }
    }

    async append(path: string, content: string | Buffer): Promise<void> {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        const existing = this.getNode(path);

        if (existing) {
            if (existing.type === 'directory') {
                throw new FSError('EISDIR', path);
            }
            const newSize = existing.content.length + buffer.length;
            // Check per-file limit
            if (newSize > MAX_FILE_SIZE) {
                throw new FSError('ENOSPC', path, `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
            }
            // Check tenant quota
            if (this.totalSize + buffer.length > MAX_TENANT_SIZE) {
                throw new FSError('ENOSPC', path, 'No space left on device');
            }
            this.totalSize += buffer.length;
            existing.content = Buffer.concat([existing.content, buffer]);
            existing.mtime = new Date();
        } else {
            // Create new file with content (write() handles limits)
            await this.write(path, buffer);
        }
    }

    async truncate(path: string, size: number): Promise<void> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.type === 'directory') {
            throw new FSError('EISDIR', path);
        }
        const oldSize = node.content.length;
        if (size < oldSize) {
            this.totalSize -= (oldSize - size);
            node.content = node.content.subarray(0, size);
        } else if (size > oldSize) {
            const delta = size - oldSize;
            // Check limits when expanding
            if (size > MAX_FILE_SIZE) {
                throw new FSError('ENOSPC', path, `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
            }
            if (this.totalSize + delta > MAX_TENANT_SIZE) {
                throw new FSError('ENOSPC', path, 'No space left on device');
            }
            this.totalSize += delta;
            const padding = Buffer.alloc(delta);
            node.content = Buffer.concat([node.content, padding]);
        }
        node.mtime = new Date();
    }

    async mkdir(path: string, mode = 0o755): Promise<void> {
        const existing = this.getNode(path);
        if (existing) {
            throw new FSError('EEXIST', path);
        }

        const parentPath = this.dirname(path);
        const parent = this.getNode(parentPath);
        if (!parent) {
            throw new FSError('ENOENT', parentPath);
        }
        if (parent.type !== 'directory') {
            throw new FSError('ENOTDIR', parentPath);
        }

        const name = this.basename(path);
        parent.children.set(name, this.createDir(name, mode));
    }

    async unlink(path: string): Promise<void> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.type === 'directory') {
            throw new FSError('EISDIR', path);
        }

        // Decrement total size
        if (node.type === 'file') {
            this.totalSize -= node.content.length;
        }

        const parentPath = this.dirname(path);
        const parent = this.getNode(parentPath);
        if (parent) {
            parent.children.delete(this.basename(path));
        }
    }

    async rmdir(path: string): Promise<void> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.type !== 'directory') {
            throw new FSError('ENOTDIR', path);
        }
        if (node.children.size > 0) {
            throw new FSError('ENOTEMPTY', path);
        }

        const parentPath = this.dirname(path);
        const parent = this.getNode(parentPath);
        if (parent) {
            parent.children.delete(this.basename(path));
        }
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const node = this.getNode(oldPath);
        if (!node) {
            throw new FSError('ENOENT', oldPath);
        }

        const newParentPath = this.dirname(newPath);
        const newParent = this.getNode(newParentPath);
        if (!newParent) {
            throw new FSError('ENOENT', newParentPath);
        }
        if (newParent.type !== 'directory') {
            throw new FSError('ENOTDIR', newParentPath);
        }

        const existing = this.getNode(newPath);
        if (existing) {
            throw new FSError('EEXIST', newPath);
        }

        // Remove from old location
        const oldParentPath = this.dirname(oldPath);
        const oldParent = this.getNode(oldParentPath);
        if (oldParent) {
            oldParent.children.delete(this.basename(oldPath));
        }

        // Add to new location
        const newName = this.basename(newPath);
        node.name = newName;
        newParent.children.set(newName, node);
    }

    async symlink(target: string, path: string): Promise<void> {
        const existing = this.getNode(path);
        if (existing) {
            throw new FSError('EEXIST', path);
        }

        const parentPath = this.dirname(path);
        const parent = this.getNode(parentPath);
        if (!parent) {
            throw new FSError('ENOENT', parentPath);
        }

        const name = this.basename(path);
        const node: MemoryNode = {
            name,
            type: 'symlink',
            content: Buffer.alloc(0),
            target,
            mode: 0o777,
            uid: '',
            mtime: new Date(),
            ctime: new Date(),
            children: new Map(),
        };
        parent.children.set(name, node);
    }

    async readlink(path: string): Promise<string> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.type !== 'symlink') {
            throw new FSError('EINVAL', path, 'Not a symlink');
        }
        return node.target || '';
    }

    async chmod(path: string, mode: number): Promise<void> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        node.mode = mode;
    }

    async chown(path: string, uid: string): Promise<void> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        node.uid = uid;
    }

    async getUsage(path: string): Promise<number> {
        const node = this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }

        if (node.type === 'file') {
            return node.content.length;
        }

        // Recursively sum directory contents
        let total = 0;
        const traverse = (n: MemoryNode): void => {
            if (n.type === 'file') {
                total += n.content.length;
            } else if (n.type === 'directory') {
                for (const child of n.children.values()) {
                    traverse(child);
                }
            }
        };
        traverse(node);
        return total;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    private getNode(path: string): MemoryNode | null {
        const normalized = this.normalizePath(path);
        if (normalized === '' || normalized === '/') {
            return this.root;
        }

        const parts = normalized.split('/').filter(Boolean);
        let current = this.root;

        for (const part of parts) {
            const child = current.children.get(part);
            if (!child) {
                return null;
            }
            current = child;
        }

        return current;
    }

    private toEntry(node: MemoryNode): FSEntry {
        return {
            name: node.name || 'tmp',
            type: node.type,
            size: node.type === 'file' ? node.content.length : 0,
            mode: node.mode,
            uid: node.uid || undefined,
            mtime: node.mtime,
            ctime: node.ctime,
            target: node.target || undefined,
        };
    }

    private createDir(name: string, mode: number): MemoryNode {
        return {
            name,
            type: 'directory',
            content: Buffer.alloc(0),
            target: null,
            mode,
            uid: '',
            mtime: new Date(),
            ctime: new Date(),
            children: new Map(),
        };
    }

    private createFile(name: string, content: Buffer): MemoryNode {
        return {
            name,
            type: 'file',
            content,
            target: null,
            mode: 0o644,
            uid: '',
            mtime: new Date(),
            ctime: new Date(),
            children: new Map(),
        };
    }

    private normalizePath(path: string): string {
        let normalized = path.replace(/\/+$/, '') || '/';
        normalized = normalized.replace(/\/+/g, '/');
        return normalized;
    }

    private dirname(path: string): string {
        const normalized = this.normalizePath(path);
        const lastSlash = normalized.lastIndexOf('/');
        if (lastSlash <= 0) return '/';
        return normalized.slice(0, lastSlash);
    }

    private basename(path: string): string {
        const normalized = this.normalizePath(path);
        return normalized.split('/').pop() || '';
    }
}
