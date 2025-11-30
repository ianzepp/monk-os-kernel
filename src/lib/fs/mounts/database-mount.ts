/**
 * DatabaseMount - Persistent FS storage using database table
 *
 * Provides a filesystem backed by the database for user home directories.
 * Mounted at /home/{username} to persist user files across server restarts.
 */

import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';
import type { System } from '../../system.js';

interface FSNode {
    id: string;
    parent_id: string | null;
    name: string;
    path: string;
    node_type: 'file' | 'directory' | 'symlink';
    content: Buffer | null;
    target: string | null;
    mode: number;
    size: number;
    owner_id: string | null;
    created_at: Date;
    updated_at: Date;
}

export class DatabaseMount implements Mount {
    constructor(private system: System) {}

    async stat(path: string): Promise<FSEntry> {
        const node = await this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        return this.toEntry(node);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const parent = await this.getNode(path);
        if (!parent) {
            throw new FSError('ENOENT', path);
        }
        if (parent.node_type !== 'directory') {
            throw new FSError('ENOTDIR', path);
        }

        const children = await this.system.database.selectAny('fs', {
            where: { parent_id: parent.id },
            order: [{ field: 'name', sort: 'asc' }],
        }) as unknown as FSNode[];

        return children.map((node) => this.toEntry(node));
    }

    async read(path: string): Promise<string | Buffer> {
        const node = await this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.node_type === 'directory') {
            throw new FSError('EISDIR', path);
        }
        if (node.node_type === 'symlink') {
            // Follow symlink
            if (!node.target) {
                throw new FSError('EINVAL', path, 'Symlink has no target');
            }
            return this.read(node.target);
        }
        // SQLite returns BLOB as Uint8Array, ensure we return Buffer
        const content = node.content;
        if (!content) return Buffer.alloc(0);
        return Buffer.isBuffer(content) ? content : Buffer.from(content);
    }

    async write(path: string, content: string | Buffer): Promise<void> {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        const existing = await this.getNode(path);

        if (existing) {
            if (existing.node_type === 'directory') {
                throw new FSError('EISDIR', path);
            }
            await this.system.database.updateOne('fs', existing.id, {
                content: buffer,
                size: buffer.length,
            });
        } else {
            // Create new file
            const parentPath = this.dirname(path);
            const parent = await this.getNode(parentPath);
            if (!parent) {
                throw new FSError('ENOENT', parentPath);
            }
            if (parent.node_type !== 'directory') {
                throw new FSError('ENOTDIR', parentPath);
            }

            await this.system.database.createOne('fs', {
                parent_id: parent.id,
                name: this.basename(path),
                path,
                node_type: 'file',
                content: buffer,
                size: buffer.length,
                mode: 0o644,
                owner_id: this.system.userId,
            });
        }
    }

    async mkdir(path: string, mode = 0o755): Promise<void> {
        const existing = await this.getNode(path);
        if (existing) {
            throw new FSError('EEXIST', path);
        }

        const parentPath = this.dirname(path);
        const parent = await this.getNode(parentPath);
        if (!parent) {
            throw new FSError('ENOENT', parentPath);
        }
        if (parent.node_type !== 'directory') {
            throw new FSError('ENOTDIR', parentPath);
        }

        await this.system.database.createOne('fs', {
            parent_id: parent.id,
            name: this.basename(path),
            path,
            node_type: 'directory',
            mode,
            owner_id: this.system.userId,
        });
    }

    async unlink(path: string): Promise<void> {
        const node = await this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.node_type === 'directory') {
            throw new FSError('EISDIR', path);
        }
        await this.system.database.deleteOne('fs', node.id);
    }

    async rmdir(path: string): Promise<void> {
        const node = await this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.node_type !== 'directory') {
            throw new FSError('ENOTDIR', path);
        }

        // Check if empty
        const children = await this.system.database.selectAny('fs', {
            where: { parent_id: node.id },
            limit: 1,
        });
        if (children.length > 0) {
            throw new FSError('ENOTEMPTY', path);
        }

        await this.system.database.deleteOne('fs', node.id);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const node = await this.getNode(oldPath);
        if (!node) {
            throw new FSError('ENOENT', oldPath);
        }

        const newParentPath = this.dirname(newPath);
        const newParent = await this.getNode(newParentPath);
        if (!newParent) {
            throw new FSError('ENOENT', newParentPath);
        }
        if (newParent.node_type !== 'directory') {
            throw new FSError('ENOTDIR', newParentPath);
        }

        // Check if target exists
        const existing = await this.getNode(newPath);
        if (existing) {
            throw new FSError('EEXIST', newPath);
        }

        await this.system.database.updateOne('fs', node.id, {
            parent_id: newParent.id,
            name: this.basename(newPath),
            path: newPath,
        });

        // If directory, update all descendant paths
        if (node.node_type === 'directory') {
            await this.updateDescendantPaths(oldPath, newPath);
        }
    }

    async symlink(target: string, path: string): Promise<void> {
        const existing = await this.getNode(path);
        if (existing) {
            throw new FSError('EEXIST', path);
        }

        const parentPath = this.dirname(path);
        const parent = await this.getNode(parentPath);
        if (!parent) {
            throw new FSError('ENOENT', parentPath);
        }

        await this.system.database.createOne('fs', {
            parent_id: parent.id,
            name: this.basename(path),
            path,
            node_type: 'symlink',
            target,
            mode: 0o777, // Symlinks are typically 777
            owner_id: this.system.userId,
        });
    }

    async readlink(path: string): Promise<string> {
        const node = await this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        if (node.node_type !== 'symlink') {
            throw new FSError('EINVAL', path, 'Not a symlink');
        }
        return node.target || '';
    }

    async chmod(path: string, mode: number): Promise<void> {
        const node = await this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        await this.system.database.updateOne('fs', node.id, { mode });
    }

    async chown(path: string, uid: string): Promise<void> {
        const node = await this.getNode(path);
        if (!node) {
            throw new FSError('ENOENT', path);
        }
        await this.system.database.updateOne('fs', node.id, { owner_id: uid });
    }

    /**
     * Get disk usage for a path
     *
     * Optimized implementation that fetches all file sizes in one query
     * and sums them in memory. More efficient than recursive stat() calls.
     *
     * @param path - Path to calculate usage for
     * @returns Total size in bytes
     */
    async getUsage(path: string): Promise<number> {
        const normalizedPath = this.normalizePath(path);
        const node = await this.getNode(normalizedPath);
        if (!node) {
            throw new FSError('ENOENT', path);
        }

        if (node.node_type === 'file') {
            return node.size || 0;
        }

        // For directories, get all descendant files in one query and sum sizes
        const likePattern = normalizedPath === '/' ? '/%' : normalizedPath + '/%';
        const files = await this.system.database.selectAny('fs', {
            where: {
                path: { $like: likePattern },
                node_type: 'file',
            },
        }) as unknown as FSNode[];

        return files.reduce((total, file) => total + (file.size || 0), 0);
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    private async getNode(path: string): Promise<FSNode | null> {
        const normalizedPath = this.normalizePath(path);
        const result = await this.system.database.selectOne('fs', {
            where: { path: normalizedPath },
        });
        return result as FSNode | null;
    }

    private toEntry(node: FSNode): FSEntry {
        return {
            name: node.name,
            type: node.node_type,
            size: node.size || 0,
            mode: node.mode,
            uid: node.owner_id || undefined,
            mtime: node.updated_at,
            ctime: node.created_at,
            target: node.target || undefined,
        };
    }

    private normalizePath(path: string): string {
        // Remove trailing slashes except for root
        let normalized = path.replace(/\/+$/, '') || '/';
        // Collapse multiple slashes
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

    private async updateDescendantPaths(oldPrefix: string, newPrefix: string): Promise<void> {
        // Get all descendants
        const descendants = await this.system.database.selectAny('fs', {
            where: {
                path: { $like: oldPrefix + '/%' },
            },
        }) as unknown as FSNode[];

        // Update each descendant's path
        for (const node of descendants) {
            const newPath = newPrefix + node.path.slice(oldPrefix.length);
            await this.system.database.updateOne('fs', node.id, {
                path: newPath,
            });
        }
    }
}

/** @deprecated Use DatabaseMount instead */
export const ModelBackedStorage = DatabaseMount;
