/**
 * VFS - Virtual File System
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The VFS is the central coordinator for all file system operations in Monk OS.
 * It implements a Plan 9-inspired "everything is a file" philosophy where:
 *
 * - Every entity (file, folder, device, process info) has a UUID
 * - Paths are resolved through a mount table to find the responsible Model
 * - Access control is grant-based (not UNIX permission bits)
 * - Host filesystem directories can be mounted read-only into the VFS
 *
 * The VFS delegates actual storage to Models (FileModel, FolderModel, etc.)
 * and uses the HAL's StorageEngine for persistence.
 *
 * PATH RESOLUTION
 * ===============
 * 1. Normalize path (handle . and .., ensure leading /)
 * 2. Check host mounts (longest prefix match, sorted by path length)
 * 3. Walk VFS storage from root, component by component
 * 4. Use child index for O(1) lookups, fall back to scan if missing
 *
 * STORAGE KEYS
 * ============
 * - entity:{uuid}     -> JSON-encoded ModelStat
 * - access:{uuid}     -> JSON-encoded ACL
 * - child:{parent}:{name} -> child UUID (index for O(1) lookup)
 * - data:{uuid}       -> File content blob
 *
 * INVARIANTS
 * ==========
 * INV-1: ROOT_ID always exists after init()
 * INV-2: Every entity has a valid parent (except root, which has null)
 * INV-3: Child index is consistent with entity parent/name fields
 * INV-4: ACL exists for every entity (explicit or default from owner)
 * INV-5: Host mounts are sorted by path length descending
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded, but async operations can interleave:
 * - Multiple callers can resolve paths simultaneously
 * - Entity creation and deletion can race with path resolution
 * - Child index updates are not atomic with entity operations
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Re-validate entity existence after resolution before operations
 * RC-2: Index backfill is idempotent (writing same value is safe)
 * RC-3: Use storage transactions where available for atomic operations
 * RC-4: Check entity existence before returning from create operations
 *
 * TOCTOU CONSIDERATIONS
 * =====================
 * Path resolution followed by operation is inherently racy. Mitigations:
 * - Access control is checked after final resolution
 * - Entity existence is re-validated before model operations
 * - For critical operations, consider file-level locking (future)
 *
 * @module vfs
 */

import type { HAL } from '@src/hal/index.js';
import type { Model, ModelStat, ModelContext, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { ACL } from '@src/vfs/acl.js';
import { checkAccess, defaultACL, encodeACL, decodeACL } from '@src/vfs/acl.js';
import { FileModel } from '@src/vfs/models/file.js';
import { FolderModel } from '@src/vfs/models/folder.js';
import { DeviceModel, initStandardDevices } from '@src/vfs/models/device.js';
import { LinkModel } from '@src/vfs/models/link.js';
import { ENOENT, EEXIST, ENOTDIR, EACCES, EINVAL } from '@src/hal/index.js';
import type { EntityCache } from '@src/ems/entity-cache.js';
import type { EntityOps } from '@src/ems/entity-ops.js';
import type { HostMount, HostMountOptions } from '@src/vfs/mounts/host.js';
import {
    createHostMount,
    isUnderHostMount,
    resolveHostPath,
    hostStat,
    hostReaddir,
    hostOpen,
} from '@src/vfs/mounts/host.js';
import type { ProcMount } from '@src/vfs/mounts/proc.js';
import {
    createProcMount,
    isUnderProcMount,
    procStat,
    procReaddir,
    procOpen,
    procSymlink,
    procUnlink,
    procReadlink,
} from '@src/vfs/mounts/proc.js';
import type { ProcessTable } from '@src/kernel/process-table.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Root folder UUID.
 *
 * WHY FIXED: Using a well-known UUID for root simplifies bootstrap.
 * We don't need to discover root - it's always this value.
 */
const ROOT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Storage key prefixes.
 *
 * WHY DOCUMENTED: Makes storage layout explicit for debugging and migration.
 */
const STORAGE_PREFIX = {
    ENTITY: 'entity:',
    ACCESS: 'access:',
    CHILD: 'child:',
    DATA: 'data:',
} as const;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Mount options for VFS-managed paths.
 */
export interface MountOptions {
    /** Enable versioning for all files in mount */
    versioned?: boolean;

    /** Quota limit in bytes (null = unlimited) */
    quotaBytes?: number | null;
}

/**
 * Mount information stored in the mount table.
 */
export interface MountInfo {
    /** Mount path prefix (normalized) */
    path: string;

    /** Model handling this mount */
    model: Model;

    /** Mount options */
    options: MountOptions;

    /** Current bytes used (for quota tracking) */
    bytesUsed: number;
}

/**
 * Result of path splitting operation.
 */
interface SplitPath {
    /** Parent directory path */
    parentPath: string;

    /** Final component name */
    name: string;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface VFSDeps {
    /** Current time in milliseconds (default: hal.clock.now) */
    now?: () => number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build a storage key for an entity.
 */
function entityKey(id: string): string {
    return `${STORAGE_PREFIX.ENTITY}${id}`;
}

/**
 * Build a storage key for an ACL.
 */
function accessKey(id: string): string {
    return `${STORAGE_PREFIX.ACCESS}${id}`;
}

/**
 * Build a storage key for a child index entry.
 */
function childKey(parentId: string, name: string): string {
    return `${STORAGE_PREFIX.CHILD}${parentId}:${name}`;
}

// =============================================================================
// VFS CLASS
// =============================================================================

/**
 * Virtual File System
 *
 * Central coordinator for:
 * - Mount table management (path prefix -> Model)
 * - Path resolution (path -> entity UUID)
 * - Access control enforcement
 * - Host filesystem integration
 */
export class VFS {
    // =========================================================================
    // CORE DEPENDENCIES
    // =========================================================================

    /**
     * Hardware Abstraction Layer.
     *
     * Used for:
     * - storage: Entity persistence
     * - clock: Timestamps for mtime/ctime
     * - entropy: UUID generation (via models)
     */
    private readonly hal: HAL;

    /**
     * Entity cache for path resolution.
     * Optional for backwards compatibility.
     */
    private readonly cache?: EntityCache;

    /**
     * Entity operations for database access.
     * Optional for backwards compatibility.
     */
    private readonly entityOps?: EntityOps;

    // =========================================================================
    // MOUNT MANAGEMENT
    // =========================================================================

    /**
     * VFS mount table: path prefix -> mount info.
     *
     * INVARIANT: Paths are normalized (leading /, no trailing /).
     * Currently only root "/" is mounted by default.
     */
    private readonly mounts: Map<string, MountInfo> = new Map();

    /**
     * Registered models by name.
     *
     * Built-in models: file, folder, device, link
     * Models define how entities of that type behave.
     */
    private readonly models: Map<string, Model> = new Map();

    /**
     * Host filesystem mounts.
     *
     * INVARIANT: Sorted by vfsPath length descending (longest prefix first).
     * This ensures correct matching when paths overlap.
     */
    private hostMounts: HostMount[] = [];

    /**
     * Proc filesystem mount.
     *
     * Synthetic mount backed by kernel's ProcessTable.
     * Set via mountProc() after kernel is available.
     */
    private procMount: ProcMount | null = null;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Initialization flag.
     *
     * WHY: init() creates root and /dev. Must be idempotent.
     * Double-init is safe but wasteful.
     */
    private initialized = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new VFS instance.
     *
     * NOTE: Does NOT initialize the filesystem. Call init() after construction.
     *
     * @param hal - Hardware abstraction layer
     * @param cache - Entity cache for path resolution (optional for backwards compat)
     * @param entityOps - Entity operations (optional for backwards compat)
     */
    constructor(hal: HAL, cache?: EntityCache, entityOps?: EntityOps) {
        this.hal = hal;
        this.cache = cache;
        this.entityOps = entityOps;

        // Register built-in models
        // FileModel and FolderModel require EMS dependencies
        if (cache && entityOps) {
            this.registerModel(new FileModel(cache, entityOps));
            this.registerModel(new FolderModel(cache, entityOps));
        }
        this.registerModel(new DeviceModel());
        this.registerModel(new LinkModel());
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize VFS with root folder and standard devices.
     *
     * IDEMPOTENT: Safe to call multiple times.
     *
     * INITIALIZATION SEQUENCE:
     * 1. Check if already initialized
     * 2. Create root folder if not exists
     * 3. Set root ACL (world-readable)
     * 4. Mount root path
     * 5. Create /dev and standard devices
     */
    async init(): Promise<void> {
        // Idempotency guard
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        // Create root folder if needed
        await this.ensureRootExists();

        // Mount root with folder model
        const folderModel = this.models.get('folder');
        if (!folderModel) {
            throw new ENOENT('Folder model not registered');
        }
        this.mount('/', folderModel, {});

        // Initialize /dev directory with standard devices
        await this.initDevices();
    }

    /**
     * Ensure root folder exists.
     *
     * Root is seeded in EMS via schema.sql. This method verifies it's in EntityCache.
     * No HAL storage is used for root - EMS is the source of truth.
     */
    private async ensureRootExists(): Promise<void> {
        // Root is seeded in schema.sql and loaded into EntityCache.
        // Just verify it exists in cache.
        if (this.cache) {
            const root = this.cache.getEntity(ROOT_ID);
            if (!root) {
                throw new EINVAL('Root entity not found in EntityCache. Database may not be initialized.');
            }
        }
        // No HAL storage needed - EMS is source of truth for File/Folder entities
    }

    /**
     * Initialize /dev directory with standard devices.
     *
     * Creates: /dev/console, /dev/null, /dev/zero, /dev/random, etc.
     */
    private async initDevices(): Promise<void> {
        const ctx = this.createContext('kernel');

        // Check if /dev already exists
        let devId = await this.resolvePath('/dev');
        if (devId) {
            return; // Already initialized
        }

        // Create /dev folder
        const folderModel = this.models.get('folder');
        if (!folderModel) {
            throw new ENOENT('Folder model not registered');
        }

        devId = await folderModel.create(ctx, ROOT_ID, 'dev', { owner: 'kernel' });

        // Index the new folder for O(1) lookup
        await this.addChildIndex(ROOT_ID, 'dev', devId);

        // Set ACL: everyone can read/stat devices
        const devACL: ACL = {
            grants: [{ to: '*', ops: ['read', 'list', 'stat'] }],
            deny: [],
        };
        await this.hal.storage.put(accessKey(devId), encodeACL(devACL));

        // Create standard devices (/dev/console, /dev/null, etc.)
        const devices = await initStandardDevices(ctx, devId);

        // Add child indexes for each device (HAL-backed entities need explicit indexing)
        for (const { name, id } of devices) {
            await this.addChildIndex(devId, name, id);
        }
    }

    // =========================================================================
    // MODEL REGISTRATION
    // =========================================================================

    /**
     * Register a model.
     *
     * Models define behavior for a class of entities (file, folder, device, etc.)
     *
     * @param model - Model to register
     */
    registerModel(model: Model): void {
        this.models.set(model.name, model);
    }

    /**
     * Get a model by name.
     *
     * @param name - Model name
     * @returns Model or undefined
     */
    getModel(name: string): Model | undefined {
        return this.models.get(name);
    }

    // =========================================================================
    // MOUNT MANAGEMENT
    // =========================================================================

    /**
     * Mount a model at a path prefix.
     *
     * All paths under the prefix will be handled by the model.
     *
     * @param path - Path prefix (e.g., "/", "/tmp")
     * @param model - Model to handle paths
     * @param options - Mount options
     */
    mount(path: string, model: Model, options: MountOptions = {}): void {
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
     *
     * @param path - Path to unmount
     */
    unmount(path: string): void {
        const normalPath = this.normalizePath(path);
        this.mounts.delete(normalPath);
    }

    /**
     * Mount a host filesystem directory into VFS.
     *
     * Host mounts provide read-only access to the actual filesystem.
     * They're checked AFTER VFS storage, so VFS entities shadow host files.
     *
     * @param vfsPath - VFS path prefix (e.g., '/bin')
     * @param hostPath - Host directory path (e.g., './src/bin')
     * @param options - Mount options (readOnly, extensions filter)
     */
    mountHost(vfsPath: string, hostPath: string, options?: HostMountOptions): void {
        const mount = createHostMount(vfsPath, hostPath, options);
        this.hostMounts.push(mount);

        // INVARIANT MAINTENANCE: Keep sorted by path length descending
        // WHY: Longest prefix match requires checking longer paths first
        this.hostMounts.sort((a, b) => b.vfsPath.length - a.vfsPath.length);
    }

    /**
     * Unmount a host filesystem directory.
     *
     * @param vfsPath - VFS path to unmount
     */
    unmountHost(vfsPath: string): void {
        const normalPath = this.normalizePath(vfsPath);
        this.hostMounts = this.hostMounts.filter(m => m.vfsPath !== normalPath);
    }

    /**
     * Mount the proc filesystem.
     *
     * Creates a synthetic /proc mount backed by the kernel's ProcessTable.
     * This should be called after the kernel is initialized.
     *
     * @param processTable - Kernel's process table
     * @param vfsPath - VFS path to mount at (default: '/proc')
     */
    mountProc(processTable: ProcessTable, vfsPath: string = '/proc'): void {
        this.procMount = createProcMount(vfsPath, processTable);
    }

    /**
     * Unmount the proc filesystem.
     */
    unmountProc(): void {
        this.procMount = null;
    }

    /**
     * Resolve a VFS path to a host filesystem path.
     *
     * Returns the absolute host path if the VFS path is under a host mount,
     * or null if not under any host mount.
     *
     * @param vfsPath - VFS path to resolve
     * @returns Absolute host path or null
     */
    resolveToHostPath(vfsPath: string): string | null {
        const normalPath = this.normalizePath(vfsPath);
        const mount = this.findHostMount(normalPath);
        if (!mount) {
            return null;
        }
        return resolveHostPath(mount, normalPath);
    }

    /**
     * Find the host mount that handles a path.
     *
     * Uses longest prefix match (host mounts are pre-sorted).
     *
     * @param path - Normalized path to check
     * @returns Matching host mount or null
     */
    private findHostMount(path: string): HostMount | null {
        // Host mounts are sorted by path length descending
        // First match is the longest (most specific) prefix
        for (const mount of this.hostMounts) {
            if (isUnderHostMount(mount, path)) {
                return mount;
            }
        }
        return null;
    }

    // =========================================================================
    // FILE OPERATIONS
    // =========================================================================

    /**
     * Open a file.
     *
     * RESOLUTION ORDER:
     * 1. Try proc mount (synthetic /proc filesystem)
     * 2. Try VFS storage (for devices, dynamic files, user files)
     * 3. Try host mounts (for bundled read-only files)
     * 4. If create flag set and not found, create in VFS
     *
     * ACCESS CONTROL: Checked after resolution, before model.open()
     *
     * @param path - File path
     * @param flags - Open flags (read, write, create, truncate, append)
     * @param caller - Caller ID for access control
     * @param opts - Open options
     * @returns File handle for I/O
     * @throws ENOENT if file not found and create not set
     * @throws EACCES if access denied
     */
    async open(
        path: string,
        flags: OpenFlags,
        caller: string,
        opts?: OpenOptions
    ): Promise<FileHandle> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        // Try proc mount first (synthetic /proc filesystem)
        if (this.procMount && isUnderProcMount(this.procMount, normalPath)) {
            // Proc mount bypasses ACL (kernel-owned)
            return procOpen(this.procMount, normalPath, flags, caller);
        }

        // Try VFS storage
        let entityId = await this.resolvePath(normalPath);

        // If not in VFS, try host mounts (read-only bundled files)
        if (!entityId) {
            const hostMount = this.findHostMount(normalPath);
            if (hostMount) {
                // Host mounts bypass ACL (they're pre-authorized at mount time)
                return hostOpen(hostMount, normalPath, flags);
            }
        }

        // Handle create flag
        if (!entityId && flags.create) {
            entityId = await this.createFile(normalPath, caller);
        }

        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // RACE FIX: Re-validate entity exists after resolution
        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity disappeared: ${entityId}`);
        }

        // Check access
        const requiredOps: string[] = [];
        if (flags.read) requiredOps.push('read');
        if (flags.write) requiredOps.push('write');

        await this.checkEntityAccess(entityId, caller, requiredOps);

        // Get model and delegate open
        const model = this.models.get(entity.model);
        if (!model) {
            throw new EINVAL(`Unknown model: ${entity.model}`);
        }

        return model.open(ctx, entityId, flags, opts);
    }

    /**
     * Get file/folder metadata.
     *
     * @param path - Path to stat
     * @param caller - Caller ID for access control
     * @returns Entity metadata
     * @throws ENOENT if path not found
     * @throws EACCES if access denied
     */
    async stat(path: string, caller: string): Promise<ModelStat> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        // Try proc mount first
        if (this.procMount && isUnderProcMount(this.procMount, normalPath)) {
            return procStat(this.procMount, normalPath, caller);
        }

        // Try VFS storage
        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            // Fall back to host mount
            const hostMount = this.findHostMount(normalPath);
            if (hostMount) {
                return hostStat(hostMount, normalPath);
            }
            throw new ENOENT(`No such file: ${path}`);
        }

        // Check access
        await this.checkEntityAccess(entityId, caller, ['stat']);

        // Get entity
        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        // Delegate to model for any computed fields
        const model = this.models.get(entity.model);
        if (!model) {
            throw new EINVAL(`Unknown model: ${entity.model}`);
        }

        return model.stat(ctx, entityId);
    }

    /**
     * Update file/folder metadata.
     *
     * @param path - Path to update
     * @param caller - Caller ID for access control
     * @param fields - Fields to update
     * @throws ENOENT if path not found
     * @throws EACCES if access denied
     */
    async setstat(path: string, caller: string, fields: Partial<ModelStat>): Promise<void> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // Write access required to modify metadata
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

    // =========================================================================
    // DIRECTORY OPERATIONS
    // =========================================================================

    /**
     * Create a directory.
     *
     * @param path - Directory path to create
     * @param caller - Caller ID for access control
     * @param opts - Options: { recursive?: boolean }
     * @returns Entity ID of created directory
     * @throws EEXIST if path exists (unless recursive and is directory)
     * @throws ENOENT if parent doesn't exist (unless recursive)
     * @throws ENOTDIR if parent is not a directory
     * @throws EACCES if access denied
     */
    async mkdir(path: string, caller: string, opts?: { recursive?: boolean }): Promise<string> {
        const normalPath = this.normalizePath(path);
        const recursive = opts?.recursive ?? false;

        // Check if already exists
        const existing = await this.resolvePath(normalPath);
        if (existing) {
            if (recursive) {
                // mkdir -p behavior: if exists and is directory, return it
                const ctx = this.createContext(caller);
                const entity = await ctx.getEntity(existing);
                if (entity?.model === 'folder') {
                    return existing;
                }
            }
            throw new EEXIST(`Path exists: ${path}`);
        }

        // Split into parent and name
        const { parentPath, name } = this.splitPath(normalPath);

        // Resolve parent
        let parentId = await this.resolvePath(parentPath);
        if (!parentId) {
            if (recursive && parentPath !== '/') {
                // Recursively create parent directories
                parentId = await this.mkdir(parentPath, caller, { recursive: true });
            } else {
                throw new ENOENT(`Parent not found: ${parentPath}`);
            }
        }

        // Verify parent is a folder
        const ctx = this.createContext(caller);
        const parent = await ctx.getEntity(parentId);
        if (!parent || parent.model !== 'folder') {
            throw new ENOTDIR(`Not a directory: ${parentPath}`);
        }

        // Check create permission on parent
        await this.checkEntityAccess(parentId, caller, ['create']);

        // Create the folder
        const folderModel = this.models.get('folder');
        if (!folderModel) {
            throw new ENOENT('Folder model not registered');
        }

        const folderId = await folderModel.create(ctx, parentId, name, { owner: caller });

        // Index for O(1) lookup
        // NOTE: Not atomic with create, but idempotent
        await this.addChildIndex(parentId, name, folderId);

        return folderId;
    }

    /**
     * Remove a file or empty directory.
     *
     * @param path - Path to remove
     * @param caller - Caller ID for access control
     * @throws ENOENT if path not found
     * @throws EACCES if access denied or trying to delete root
     */
    async unlink(path: string, caller: string): Promise<void> {
        const normalPath = this.normalizePath(path);

        // Try proc mount first (for /proc/{uuid}/path/ entries)
        if (this.procMount && isUnderProcMount(this.procMount, normalPath)) {
            await procUnlink(this.procMount, normalPath, caller);
            return;
        }

        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // Cannot delete root
        if (entityId === ROOT_ID) {
            throw new EACCES('Cannot delete root');
        }

        // Check delete permission
        await this.checkEntityAccess(entityId, caller, ['delete']);

        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        const model = this.models.get(entity.model);
        if (!model) {
            throw new EINVAL(`Unknown model: ${entity.model}`);
        }

        // Remove index BEFORE unlink
        // WHY: Prevents findChild from returning deleted entity during race
        if (entity.parent) {
            await this.removeChildIndex(entity.parent, entity.name);
        }

        await model.unlink(ctx, entityId);
    }

    /**
     * Create a symbolic link.
     *
     * NOTE: Symbolic links are currently disabled and will throw EPERM.
     *
     * @param target - Link target path
     * @param linkPath - Path for the new link
     * @param caller - Caller ID for access control
     * @returns Link entity ID
     */
    async symlink(target: string, linkPath: string, caller: string): Promise<string> {
        const normalPath = this.normalizePath(linkPath);

        // Try proc mount first (for /proc/{uuid}/path/ entries)
        if (this.procMount && isUnderProcMount(this.procMount, normalPath)) {
            await procSymlink(this.procMount, target, normalPath, caller);
            // Return a synthetic ID for proc symlinks
            return `proc-link:${normalPath}`;
        }

        const { parentPath, name } = this.splitPath(normalPath);

        // Resolve parent
        const parentId = await this.resolvePath(parentPath);
        if (!parentId) {
            throw new ENOENT(`Parent not found: ${parentPath}`);
        }

        // Verify parent is a folder
        const ctx = this.createContext(caller);
        const parent = await ctx.getEntity(parentId);
        if (!parent || parent.model !== 'folder') {
            throw new ENOTDIR(`Not a directory: ${parentPath}`);
        }

        // Check create permission on parent
        await this.checkEntityAccess(parentId, caller, ['create']);

        // Create link (LinkModel.create throws EPERM currently)
        const linkModel = this.models.get('link');
        if (!linkModel) {
            throw new ENOENT('Link model not registered');
        }

        return linkModel.create(ctx, parentId, name, { target, owner: caller });
    }

    /**
     * Read a symbolic link target.
     *
     * @param path - Link path
     * @param caller - Caller ID for access control
     * @returns Link target path
     * @throws ENOENT if path not found or not a symlink
     * @throws EACCES if access denied
     */
    async readlink(path: string, caller: string): Promise<string> {
        const normalPath = this.normalizePath(path);

        // Try proc mount first
        if (this.procMount && isUnderProcMount(this.procMount, normalPath)) {
            return procReadlink(this.procMount, normalPath, caller);
        }

        // For VFS links, stat returns target in the result
        const stat = await this.stat(path, caller);
        if (stat.model !== 'link' || !stat.target) {
            throw new ENOENT(`Not a symbolic link: ${path}`);
        }

        return stat.target as string;
    }

    /**
     * List directory contents.
     *
     * @param path - Directory path
     * @param caller - Caller ID for access control
     * @yields Child entity metadata
     * @throws ENOENT if path not found
     * @throws ENOTDIR if path is not a directory
     * @throws EACCES if access denied
     */
    async *readdir(path: string, caller: string): AsyncIterable<ModelStat> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        // Try proc mount first
        if (this.procMount && isUnderProcMount(this.procMount, normalPath)) {
            yield* procReaddir(this.procMount, normalPath, caller);
            return;
        }

        // Try VFS storage
        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            // Fall back to host mount
            const hostMount = this.findHostMount(normalPath);
            if (hostMount) {
                yield* hostReaddir(hostMount, normalPath);
                return;
            }
            throw new ENOENT(`No such directory: ${path}`);
        }

        // Check list permission
        await this.checkEntityAccess(entityId, caller, ['list']);

        const entity = await ctx.getEntity(entityId);
        if (!entity || entity.model !== 'folder') {
            throw new ENOTDIR(`Not a directory: ${path}`);
        }

        // Delegate to folder model
        const folderModel = this.models.get('folder');
        if (!folderModel) {
            throw new ENOENT('Folder model not registered');
        }

        for await (const childId of folderModel.list(ctx, entityId)) {
            const child = await ctx.getEntity(childId);
            if (child) {
                yield child;
            }
            // Skip children that disappeared (race condition)
        }
    }

    // =========================================================================
    // ACCESS CONTROL
    // =========================================================================

    /**
     * Get ACL for an entity.
     *
     * @param path - Entity path
     * @param caller - Caller ID for access control
     * @returns ACL
     * @throws ENOENT if path not found
     * @throws EACCES if access denied
     */
    async access(path: string, caller: string): Promise<ACL> {
        const normalPath = this.normalizePath(path);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // Need stat permission to view ACL
        await this.checkEntityAccess(entityId, caller, ['stat']);

        return this.getACL(entityId);
    }

    /**
     * Set ACL for an entity.
     *
     * @param path - Entity path
     * @param caller - Caller ID for access control
     * @param acl - New ACL (null resets to default)
     * @throws ENOENT if path not found
     * @throws EACCES if access denied (requires * permission)
     */
    async setAccess(path: string, caller: string, acl: ACL | null): Promise<void> {
        const normalPath = this.normalizePath(path);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // Requires full control to modify ACL
        await this.checkEntityAccess(entityId, caller, ['*']);

        if (acl === null) {
            // Reset to default ACL (owner-based)
            const ctx = this.createContext(caller);
            const entity = await ctx.getEntity(entityId);
            if (entity) {
                await this.hal.storage.put(accessKey(entityId), encodeACL(defaultACL(entity.owner)));
            }
        } else {
            await this.hal.storage.put(accessKey(entityId), encodeACL(acl));
        }
    }

    // =========================================================================
    // WATCH
    // =========================================================================

    /**
     * Watch for changes to an entity.
     *
     * @param path - Path to watch
     * @param caller - Caller ID for access control
     * @param pattern - Optional glob pattern for filtering
     * @yields Watch events
     * @throws ENOENT if path not found
     * @throws EACCES if access denied
     */
    async *watch(path: string, caller: string, pattern?: string): AsyncIterable<WatchEvent> {
        const normalPath = this.normalizePath(path);
        const ctx = this.createContext(caller);

        const entityId = await this.resolvePath(normalPath);
        if (!entityId) {
            throw new ENOENT(`No such file: ${path}`);
        }

        // Need stat permission to watch
        await this.checkEntityAccess(entityId, caller, ['stat']);

        const entity = await ctx.getEntity(entityId);
        if (!entity) {
            throw new ENOENT(`Entity not found: ${entityId}`);
        }

        const model = this.models.get(entity.model);
        if (!model || !model.watch) {
            return; // Model doesn't support watch
        }

        yield* model.watch(ctx, entityId, pattern);
    }

    // =========================================================================
    // PATH UTILITIES
    // =========================================================================

    /**
     * Normalize a path.
     *
     * - Handles . (current) and .. (parent)
     * - Ensures leading /
     * - Removes trailing /
     * - Collapses multiple /
     *
     * @param path - Path to normalize
     * @returns Normalized path
     */
    private normalizePath(path: string): string {
        const parts = path.split('/').filter(Boolean);
        const normalized: string[] = [];

        for (const part of parts) {
            if (part === '..') {
                // Go up, but never above root
                normalized.pop();
            } else if (part !== '.') {
                normalized.push(part);
            }
        }

        return '/' + normalized.join('/');
    }

    /**
     * Split a path into parent and name components.
     *
     * @param path - Normalized path
     * @returns Parent path and final name
     */
    private splitPath(path: string): SplitPath {
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash <= 0) {
            // Path is like "/foo" - parent is root
            return { parentPath: '/', name: path.slice(1) };
        }
        return {
            parentPath: path.slice(0, lastSlash) || '/',
            name: path.slice(lastSlash + 1),
        };
    }

    /**
     * Resolve a path to an entity UUID.
     *
     * ALGORITHM:
     * 1. Handle root case specially
     * 2. Split path into components
     * 3. Walk from root, looking up each component
     * 4. Use child index for O(1) lookup (falls back to scan)
     *
     * @param path - Normalized path
     * @returns Entity UUID or null if not found
     */
    private async resolvePath(path: string): Promise<string | null> {
        // Special case: root
        if (path === '/') {
            return ROOT_ID;
        }

        // Split into components
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

    /**
     * Find a child entity by name.
     *
     * For EMS entities (file, folder): uses EntityCache for O(1) lookup
     * For HAL entities (device, proc, link): falls back to HAL child index
     *
     * @param parentId - Parent entity UUID
     * @param name - Child name
     * @returns Child UUID or null
     */
    private async findChild(parentId: string, name: string): Promise<string | null> {
        // Try EntityCache first (EMS entities: file, folder)
        if (this.cache) {
            const childId = this.cache.getChild(parentId, name);
            if (childId) {
                return childId;
            }
        }

        // Fall back to HAL child index (virtual entities: device, proc, link)
        // These use HAL KV storage by design - they're virtual/ephemeral
        const indexKey = childKey(parentId, name);
        const indexData = await this.hal.storage.get(indexKey);
        if (indexData) {
            return new TextDecoder().decode(indexData);
        }

        return null;
    }

    /**
     * Add a child index entry.
     *
     * NOTE: With EMS-backed entities, EntityCache is updated via Ring 8 observer.
     * This method is kept for non-EMS entities (devices, procs, links) that still
     * use HAL storage directly.
     *
     * @param parentId - Parent entity UUID
     * @param name - Child name
     * @param entityId - Child entity UUID
     */
    private async addChildIndex(parentId: string, name: string, entityId: string): Promise<void> {
        // For EMS-backed entities (file, folder), EntityCache is updated via Ring 8 observer.
        // For HAL-backed entities (device, proc, link), we use HAL child index.
        // This hybrid approach is intentional - virtual entities don't need SQL persistence.
        const key = childKey(parentId, name);
        await this.hal.storage.put(key, new TextEncoder().encode(entityId));
    }

    /**
     * Remove a child index entry.
     *
     * NOTE: With EMS-backed entities, EntityCache is updated via Ring 8 observer.
     *
     * @param parentId - Parent entity UUID
     * @param name - Child name
     */
    private async removeChildIndex(parentId: string, name: string): Promise<void> {
        // For EMS-backed entities (file, folder), EntityCache is updated via Ring 8 observer.
        // For HAL-backed entities (device, proc, link), we still need HAL index.
        const key = childKey(parentId, name);
        await this.hal.storage.delete(key);
    }

    // =========================================================================
    // FILE CREATION
    // =========================================================================

    /**
     * Create a file at the given path.
     *
     * @param path - Normalized file path
     * @param caller - Caller ID (becomes owner)
     * @returns Created entity UUID
     * @throws ENOENT if parent doesn't exist
     * @throws ENOTDIR if parent is not a directory
     * @throws EACCES if access denied
     */
    private async createFile(path: string, caller: string): Promise<string> {
        const { parentPath, name } = this.splitPath(path);

        // Resolve parent
        const parentId = await this.resolvePath(parentPath);
        if (!parentId) {
            throw new ENOENT(`Parent not found: ${parentPath}`);
        }

        // Verify parent is a folder
        const ctx = this.createContext(caller);
        const parent = await ctx.getEntity(parentId);
        if (!parent || parent.model !== 'folder') {
            throw new ENOTDIR(`Not a directory: ${parentPath}`);
        }

        // Check create permission
        await this.checkEntityAccess(parentId, caller, ['create']);

        // Create file
        const fileModel = this.models.get('file');
        if (!fileModel) {
            throw new ENOENT('File model not registered');
        }

        const fileId = await fileModel.create(ctx, parentId, name, { owner: caller });

        // Index for O(1) lookup
        await this.addChildIndex(parentId, name, fileId);

        // Create default ACL (owner has full control, world-readable)
        await this.hal.storage.put(accessKey(fileId), encodeACL(defaultACL(caller)));

        return fileId;
    }

    // =========================================================================
    // ACCESS CONTROL HELPERS
    // =========================================================================

    /**
     * Get ACL for an entity.
     *
     * If no explicit ACL, returns default based on owner.
     *
     * @param entityId - Entity UUID
     * @returns ACL
     */
    private async getACL(entityId: string): Promise<ACL> {
        const data = await this.hal.storage.get(accessKey(entityId));
        if (data) {
            return decodeACL(data);
        }

        // No explicit ACL - derive from owner
        const entityData = await this.hal.storage.get(entityKey(entityId));
        if (entityData) {
            const entity = JSON.parse(new TextDecoder().decode(entityData)) as ModelStat;
            return defaultACL(entity.owner);
        }

        // EMS entities don't have HAL-based ACLs - they use default permissive ACL
        // ACL enforcement happens at the VFS layer for all entity types
        return { grants: [{ to: '*', ops: ['*'] }], deny: [] };
    }

    /**
     * Check if caller has required permissions on an entity.
     *
     * @param entityId - Entity UUID
     * @param caller - Caller ID
     * @param ops - Required operations
     * @throws EACCES if access denied
     */
    private async checkEntityAccess(entityId: string, caller: string, ops: string[]): Promise<void> {
        // Kernel bypasses all ACL checks
        if (caller === 'kernel') {
            return;
        }

        const acl = await this.getACL(entityId);
        const now = this.hal.clock.now();

        for (const op of ops) {
            // Check caller's access, and also wildcard (*) for public access
            const hasAccess = checkAccess(acl, caller, op, now) ||
                              checkAccess(acl, '*', op, now);
            if (!hasAccess) {
                throw new EACCES(`Permission denied: ${op}`);
            }
        }
    }

    // =========================================================================
    // CONTEXT FACTORY
    // =========================================================================

    /**
     * Create a model context for the given caller.
     *
     * The context provides models with access to:
     * - HAL for storage/clock/entropy
     * - Path resolution
     * - Entity lookup
     * - Path computation
     *
     * @param caller - Caller ID
     * @returns Model context
     */
    private createContext(caller: string): ModelContext {
        const self = this;
        return {
            hal: this.hal,
            caller,

            /**
             * Resolve path to entity UUID.
             */
            async resolve(path: string): Promise<string | null> {
                return self.resolvePath(path);
            },

            /**
             * Get entity by UUID.
             *
             * For EMS-backed entities (file, folder): EntityCache → EntityOps
             * For HAL-backed entities (device, proc, link): HAL storage
             */
            async getEntity(id: string): Promise<ModelStat | null> {
                // EMS entities: EntityCache → EntityOps
                if (self.cache && self.entityOps) {
                    const cached = self.cache.getEntity(id);
                    if (cached) {
                        // Query detail table for full record
                        for await (const record of self.entityOps.selectAny(
                            cached.model,
                            { where: { id }, limit: 1 }
                        )) {
                            // Map EMS fields to VFS ModelStat
                            const rec = record as Record<string, unknown>;
                            const updatedAt = rec.updated_at as string | undefined;
                            const createdAt = rec.created_at as string | undefined;
                            return {
                                ...record,
                                id: cached.id,
                                model: cached.model,
                                parent: cached.parent,
                                name: cached.pathname,
                                // Map EMS timestamps to VFS format
                                mtime: updatedAt ? new Date(updatedAt).getTime() : Date.now(),
                                ctime: createdAt ? new Date(createdAt).getTime() : Date.now(),
                                // Default size for models without it (folders)
                                size: (rec.size as number) ?? 0,
                            } as unknown as ModelStat;
                        }
                    }
                }

                // HAL entities (device, proc, link): use HAL storage by design
                // Virtual entities don't need SQL persistence
                const data = await self.hal.storage.get(entityKey(id));
                if (!data) return null;
                return JSON.parse(new TextDecoder().decode(data));
            },

            /**
             * Compute full path for an entity.
             *
             * For EMS entities: uses EntityCache (O(1) per hop)
             * For HAL entities: falls back to HAL storage
             */
            async computePath(id: string): Promise<string> {
                const parts: string[] = [];
                let currentId: string | null = id;

                while (currentId && currentId !== ROOT_ID) {
                    // EMS entities: use EntityCache
                    if (self.cache) {
                        const cached = self.cache.getEntity(currentId);
                        if (cached) {
                            parts.unshift(cached.pathname);
                            currentId = cached.parent;
                            continue;
                        }
                    }

                    // HAL entities (device, proc, link): use HAL storage by design
                    const data = await self.hal.storage.get(entityKey(currentId));
                    if (!data) break;

                    const entity = JSON.parse(new TextDecoder().decode(data)) as ModelStat;
                    parts.unshift(entity.name);
                    currentId = entity.parent;
                }

                return '/' + parts.join('/');
            },
        };
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Check if VFS is initialized.
     * TESTING: Verify init() was called.
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get mount count.
     * TESTING: Verify mount operations.
     */
    getMountCount(): number {
        return this.mounts.size;
    }

    /**
     * Get host mount count.
     * TESTING: Verify host mount operations.
     */
    getHostMountCount(): number {
        return this.hostMounts.length;
    }

    /**
     * Get registered model names.
     * TESTING: Verify model registration.
     */
    getModelNames(): string[] {
        return Array.from(this.models.keys());
    }
}
