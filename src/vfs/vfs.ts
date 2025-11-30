/**
 * VFS - Virtual File System
 *
 * Central coordinator for:
 * - Mount table (path prefix → Model)
 * - Path resolution (path → entity UUID)
 * - Access control enforcement
 * - Quota tracking
 */

import type { HAL } from '@src/hal/index.js';
import type { Model, ModelStat, ModelContext, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { ACL } from '@src/vfs/acl.js';
import { checkAccess, defaultACL, encodeACL, decodeACL } from '@src/vfs/acl.js';
import { FileModel } from '@src/vfs/models/file.js';
import { FolderModel } from '@src/vfs/models/folder.js';
import { DeviceModel, initStandardDevices } from '@src/vfs/models/device.js';
import { ENOENT, EEXIST, ENOTDIR, EACCES, EINVAL } from '@src/hal/index.js';
import type { HostMount, HostMountOptions } from '@src/vfs/mounts/host.js';
import {
    createHostMount,
    isUnderHostMount,
    hostStat,
    hostReaddir,
    hostOpen,
} from '@src/vfs/mounts/host.js';

/**
 * Mount options
 */
export interface MountOptions {
    /** Enable versioning for all files in mount */
    versioned?: boolean;
    /** Quota limit in bytes (null = unlimited) */
    quotaBytes?: number | null;
}

/**
 * Mount information
 */
export interface MountInfo {
    /** Mount path prefix */
    path: string;
    /** Model handling this mount */
    model: Model;
    /** Mount options */
    options: MountOptions;
    /** Current bytes used (for quota) */
    bytesUsed: number;
}

/**
 * Root folder constant
 */
const ROOT_ID = '00000000-0000-0000-0000-000000000000';
const ROOT_NAME = '';

/**
 * VFS class
 */
export class VFS {
    private hal: HAL;
    private mounts: Map<string, MountInfo> = new Map();
    private models: Map<string, Model> = new Map();
    private hostMounts: HostMount[] = [];

    constructor(hal: HAL) {
        this.hal = hal;

        // Register built-in models
        this.registerModel(new FileModel());
        this.registerModel(new FolderModel());
        this.registerModel(new DeviceModel());
    }

    /**
     * Initialize VFS with root folder.
     */
    async init(): Promise<void> {
        // Create root folder if it doesn't exist
        const rootData = await this.hal.storage.get(`entity:${ROOT_ID}`);
        if (!rootData) {
            const now = this.hal.clock.now();
            const root: ModelStat = {
                id: ROOT_ID,
                model: 'folder',
                name: ROOT_NAME,
                parent: null,
                owner: ROOT_ID,
                size: 0,
                mtime: now,
                ctime: now,
            };
            await this.hal.storage.put(
                `entity:${ROOT_ID}`,
                new TextEncoder().encode(JSON.stringify(root))
            );

            // Root ACL: everyone can read/list/create at root level
            const rootACL: ACL = {
                grants: [{ to: '*', ops: ['read', 'list', 'stat', 'create'] }],
                deny: [],
            };
            await this.hal.storage.put(`access:${ROOT_ID}`, encodeACL(rootACL));
        }

        // Mount root
        this.mount('/', this.models.get('folder')!, {});

        // Create /dev folder and standard devices
        await this.initDevices();
    }

    /**
     * Initialize /dev directory with standard devices.
     */
    private async initDevices(): Promise<void> {
        const ctx = this.createContext('kernel');

        // Check if /dev already exists
        let devId = await this.resolvePath('/dev');
        if (!devId) {
            // Create /dev folder
            const folderModel = this.models.get('folder')!;
            devId = await folderModel.create(ctx, ROOT_ID, 'dev', { owner: 'kernel' });

            // Set ACL to allow all to read/stat
            const devACL: ACL = {
                grants: [{ to: '*', ops: ['read', 'list', 'stat'] }],
                deny: [],
            };
            await this.hal.storage.put(`access:${devId}`, encodeACL(devACL));

            // Create standard devices
            await initStandardDevices(ctx, devId);
        }
    }

    /**
     * Register a model.
     */
    registerModel(model: Model): void {
        this.models.set(model.name, model);
    }

    /**
     * Mount a model at a path prefix.
     */
    mount(path: string, model: Model, options: MountOptions = {}): void {
        // Normalize path
        const normalPath = this.normalizePath(path);

        this.mounts.set(normalPath, {
            path: normalPath,
            model,
            options,
            bytesUsed: 0,
        });
    }

    /**
     * Unmount a path.
     */
    unmount(path: string): void {
        const normalPath = this.normalizePath(path);
        this.mounts.delete(normalPath);
    }

    /**
     * Mount a host filesystem directory into VFS.
     *
     * @param vfsPath - VFS path prefix (e.g., '/bin')
     * @param hostPath - Host directory path (e.g., './src/bin')
     * @param options - Mount options
     */
    mountHost(vfsPath: string, hostPath: string, options?: HostMountOptions): void {
        const mount = createHostMount(vfsPath, hostPath, options);
        this.hostMounts.push(mount);

        // Sort by path length descending (longest prefix first)
        this.hostMounts.sort((a, b) => b.vfsPath.length - a.vfsPath.length);
    }

    /**
     * Unmount a host filesystem directory.
     */
    unmountHost(vfsPath: string): void {
        const normalPath = this.normalizePath(vfsPath);
        this.hostMounts = this.hostMounts.filter(m => m.vfsPath !== normalPath);
    }

    /**
     * Find host mount for a path.
     */
    private findHostMount(path: string): HostMount | null {
        for (const mount of this.hostMounts) {
            if (isUnderHostMount(mount, path)) {
                return mount;
            }
        }
        return null;
    }

    /**
     * Open a file.
     */
    async open(
        path: string,
        flags: OpenFlags,
        caller: string,
        opts?: OpenOptions
    ): Promise<FileHandle> {
        const normalPath = this.normalizePath(path);

        // Check host mounts first
        const hostMount = this.findHostMount(normalPath);
        if (hostMount) {
            return hostOpen(hostMount, normalPath, flags);
        }

        const ctx = this.createContext(caller);

        // Resolve path to entity
        let entityId = await this.resolvePath(normalPath);

        // Handle create flag
        if (!entityId && flags.create) {
            entityId = await this.createFile(normalPath, caller);
        }

        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // Get entity to determine model
        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        // Check access
        const requiredOps: string[] = [];
        if (flags.read) requiredOps.push('read');
        if (flags.write) requiredOps.push('write');

        await this.checkEntityAccess(entityId, caller, requiredOps);

        // Get model and open
        const model = this.models.get(entity.model);
        if (!model) {
            throw new EINVAL(`Unknown model: ${entity.model}`);
        }

        return model.open(ctx, entityId, flags, opts);
    }

    /**
     * Get file/folder metadata.
     */
    async stat(path: string, caller: string): Promise<ModelStat> {
        const normalPath = this.normalizePath(path);

        // Check host mounts first
        const hostMount = this.findHostMount(normalPath);
        if (hostMount) {
            return hostStat(hostMount, normalPath);
        }

        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        await this.checkEntityAccess(entityId, caller, ['stat']);

        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        const model = this.models.get(entity.model);
        if (!model) {
            throw new EINVAL(`Unknown model: ${entity.model}`);
        }

        return model.stat(ctx, entityId);
    }

    /**
     * Update file/folder metadata.
     */
    async setstat(path: string, caller: string, fields: Partial<ModelStat>): Promise<void> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        await this.checkEntityAccess(entityId, caller, ['write']);

        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        const model = this.models.get(entity.model);
        if (!model) {
            throw new EINVAL(`Unknown model: ${entity.model}`);
        }

        await model.setstat(ctx, entityId, fields);
    }

    /**
     * Create a directory.
     *
     * @param path - Directory path to create
     * @param caller - Caller ID for access control
     * @param opts - Options: { recursive?: boolean }
     *   - recursive: Create parent directories as needed (like mkdir -p)
     * @returns Entity ID of created directory
     */
    async mkdir(path: string, caller: string, opts?: { recursive?: boolean }): Promise<string> {
        const normalPath = this.normalizePath(path);
        const recursive = opts?.recursive ?? false;

        // Check if already exists
        const existing = await this.resolvePath(normalPath);
        if (existing) {
            if (recursive) {
                // Like mkdir -p: if it exists and is a directory, that's ok
                const ctx = this.createContext(caller);
                const entity = await ctx.getEntity(existing);
                if (entity?.model === 'folder') {
                    return existing;
                }
            }
            throw new EEXIST(`Path exists: ${path}`);
        }

        // Get parent path and name
        const { parentPath, name } = this.splitPath(normalPath);

        // Resolve parent
        let parentId = await this.resolvePath(parentPath);
        if (!parentId) {
            if (recursive && parentPath !== '/') {
                // Recursively create parent
                parentId = await this.mkdir(parentPath, caller, { recursive: true });
            } else {
                throw new ENOENT(`Parent not found: ${parentPath}`);
            }
        }

        // Check parent is a folder
        const ctx = this.createContext(caller);
        const parent = await ctx.getEntity(parentId);
        if (!parent || parent.model !== 'folder') {
            throw new ENOTDIR(`Not a directory: ${parentPath}`);
        }

        // Check access on parent
        await this.checkEntityAccess(parentId, caller, ['create']);

        // Create folder
        const folderModel = this.models.get('folder')!;
        return folderModel.create(ctx, parentId, name, { owner: caller });
    }

    /**
     * Remove a file or empty directory.
     */
    async unlink(path: string, caller: string): Promise<void> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // Can't delete root
        if (entityId === ROOT_ID) {
            throw new EACCES('Cannot delete root');
        }

        await this.checkEntityAccess(entityId, caller, ['delete']);

        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        const model = this.models.get(entity.model);
        if (!model) {
            throw new EINVAL(`Unknown model: ${entity.model}`);
        }

        await model.unlink(ctx, entityId);
    }

    /**
     * List directory contents.
     */
    async *readdir(path: string, caller: string): AsyncIterable<ModelStat> {
        const normalPath = this.normalizePath(path);

        // Check host mounts first
        const hostMount = this.findHostMount(normalPath);
        if (hostMount) {
            yield* hostReaddir(hostMount, normalPath);
            return;
        }

        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such directory: ${path}`);
        }

        await this.checkEntityAccess(entityId, caller, ['list']);

        const entity = await ctx.getEntity(entityId);
        if (!entity || entity.model !== 'folder') {
            throw new ENOTDIR(`Not a directory: ${path}`);
        }

        const folderModel = this.models.get('folder')!;
        for await (const childId of folderModel.list(ctx, entityId)) {
            const child = await ctx.getEntity(childId);
            if (child) {
                yield child;
            }
        }
    }

    /**
     * Get ACL for entity.
     */
    async access(path: string, caller: string): Promise<ACL> {
        const normalPath = this.normalizePath(path);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        await this.checkEntityAccess(entityId, caller, ['stat']);

        return this.getACL(entityId);
    }

    /**
     * Set ACL for entity.
     */
    async setAccess(path: string, caller: string, acl: ACL | null): Promise<void> {
        const normalPath = this.normalizePath(path);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        await this.checkEntityAccess(entityId, caller, ['*']);

        if (acl === null) {
            // Reset to default (creator-only)
            const ctx = this.createContext(caller);
            const entity = await ctx.getEntity(entityId);
            if (entity) {
                await this.hal.storage.put(`access:${entityId}`, encodeACL(defaultACL(entity.owner)));
            }
        } else {
            await this.hal.storage.put(`access:${entityId}`, encodeACL(acl));
        }
    }

    /**
     * Watch for changes.
     */
    async *watch(path: string, caller: string, pattern?: string): AsyncIterable<WatchEvent> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        await this.checkEntityAccess(entityId, caller, ['stat']);

        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        const model = this.models.get(entity.model);
        if (!model || !model.watch) {
            return;
        }

        yield* model.watch(ctx, entityId, pattern);
    }

    // ========================================================================
    // Private helpers
    // ========================================================================

    private normalizePath(path: string): string {
        // Remove trailing slash (except for root)
        let normalized = path.replace(/\/+$/, '') || '/';

        // Ensure leading slash
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }

        // Collapse multiple slashes
        normalized = normalized.replace(/\/+/g, '/');

        return normalized;
    }

    private splitPath(path: string): { parentPath: string; name: string } {
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash <= 0) {
            return { parentPath: '/', name: path.slice(1) };
        }
        return {
            parentPath: path.slice(0, lastSlash) || '/',
            name: path.slice(lastSlash + 1),
        };
    }

    private async resolvePath(path: string): Promise<string | null> {
        if (path === '/') {
            return ROOT_ID;
        }

        // Split path into components
        const parts = path.split('/').filter(Boolean);

        // Walk from root
        let currentId = ROOT_ID;
        for (const part of parts) {
            const childId = await this.findChild(currentId, part);
            if (!childId) {
                return null;
            }
            currentId = childId;
        }

        return currentId;
    }

    private async findChild(parentId: string, name: string): Promise<string | null> {
        // Scan entities with this parent
        for await (const key of this.hal.storage.list('entity:')) {
            const data = await this.hal.storage.get(key);
            if (!data) continue;

            const entity = JSON.parse(new TextDecoder().decode(data)) as ModelStat;
            if (entity.parent === parentId && entity.name === name) {
                return entity.id;
            }
        }

        return null;
    }

    private async createFile(path: string, caller: string): Promise<string> {
        const { parentPath, name } = this.splitPath(path);

        // Resolve parent
        const parentId = await this.resolvePath(parentPath);
        if (!parentId) {
            throw new ENOENT(`Parent not found: ${parentPath}`);
        }

        // Check parent is a folder
        const ctx = this.createContext(caller);
        const parent = await ctx.getEntity(parentId);
        if (!parent || parent.model !== 'folder') {
            throw new ENOTDIR(`Not a directory: ${parentPath}`);
        }

        // Check access on parent
        await this.checkEntityAccess(parentId, caller, ['create']);

        // Create file
        const fileModel = this.models.get('file')!;
        const fileId = await fileModel.create(ctx, parentId, name, { owner: caller });

        // Create default ACL
        await this.hal.storage.put(`access:${fileId}`, encodeACL(defaultACL(caller)));

        return fileId;
    }

    private async getACL(entityId: string): Promise<ACL> {
        const data = await this.hal.storage.get(`access:${entityId}`);
        if (!data) {
            // No ACL stored - check entity for owner
            const entityData = await this.hal.storage.get(`entity:${entityId}`);
            if (entityData) {
                const entity = JSON.parse(new TextDecoder().decode(entityData)) as ModelStat;
                return defaultACL(entity.owner);
            }
            return { grants: [], deny: [] };
        }
        return decodeACL(data);
    }

    private async checkEntityAccess(entityId: string, caller: string, ops: string[]): Promise<void> {
        // Kernel bypasses all ACL checks
        if (caller === 'kernel') {
            return;
        }

        const acl = await this.getACL(entityId);
        const now = this.hal.clock.now();

        for (const op of ops) {
            // Wildcard caller '*' matches everyone (for public access)
            const hasAccess = checkAccess(acl, caller, op, now) ||
                              checkAccess(acl, '*', op, now);
            if (!hasAccess) {
                throw new EACCES(`Permission denied: ${op}`);
            }
        }
    }

    private createContext(caller: string): ModelContext {
        const self = this;
        return {
            hal: this.hal,
            caller,

            async resolve(path: string): Promise<string | null> {
                return self.resolvePath(path);
            },

            async getEntity(id: string): Promise<ModelStat | null> {
                const data = await self.hal.storage.get(`entity:${id}`);
                if (!data) return null;
                return JSON.parse(new TextDecoder().decode(data));
            },

            async computePath(id: string): Promise<string> {
                const parts: string[] = [];
                let currentId: string | null = id;

                while (currentId && currentId !== ROOT_ID) {
                    const data = await self.hal.storage.get(`entity:${currentId}`);
                    if (!data) break;

                    const entity = JSON.parse(new TextDecoder().decode(data)) as ModelStat;
                    parts.unshift(entity.name);
                    currentId = entity.parent;
                }

                return '/' + parts.join('/');
            },
        };
    }
}
