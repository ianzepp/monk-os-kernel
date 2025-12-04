/**
 * FolderModel - Organizational container for files and other folders
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FolderModel implements directory semantics for Monk OS. Unlike files, folders
 * have no data blob - they exist purely as organizational containers. Child
 * entities are found by querying for entities whose 'parent' field matches the
 * folder's UUID.
 *
 * This parent-pointer design (vs. child-list design) simplifies rename and move
 * operations: only the moved entity's parent field needs updating. However, it
 * makes listing children O(n) where n is total entities, since we must scan all
 * entities to find those with matching parent. For large filesystems, an index
 * on parent would be essential.
 *
 * Folders cannot be opened for I/O - attempting to open() throws EISDIR. This
 * matches POSIX semantics where directories are read via readdir(), not read().
 *
 * STATE MACHINE
 * =============
 * Folders have no handle state. They exist or don't exist.
 *
 *   create() ──────────> EXISTS ──────────> (deleted)
 *                          │                    ^
 *                          │ unlink()           │
 *                          │ (only if empty)    │
 *                          └────────────────────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: folder.size is always 0 (folders have no intrinsic size)
 * INV-2: folder.data is always undefined (no data blob)
 * INV-3: Folders can only be deleted when empty (no children)
 * INV-4: ctime is set once at creation and never modified
 * INV-5: mtime is updated on metadata changes (NOT on child changes)
 * INV-6: Root folder has parent = null
 *
 * CONCURRENCY MODEL
 * =================
 * Folder operations are atomic at the storage layer. The list() operation
 * provides a snapshot view - entities created during iteration may or may
 * not be included. Delete checks for emptiness, but a concurrent create()
 * could add a child between the check and delete - this would orphan the
 * child. Production systems should use advisory locking on folder deletion.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Empty check before delete (TOCTOU vulnerable - see above)
 * RC-2: Storage operations are individually atomic
 *
 * MEMORY MANAGEMENT
 * =================
 * - list() yields entity IDs lazily via async iterator
 * - No buffering of child entities (streaming enumeration)
 * - Watch events are yielded as they arrive (no queuing)
 *
 * @module vfs/models/folder
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { DatabaseOps, DbRecord } from '@src/model/database-ops.js';
import type { EntityCache, CachedEntity } from '@src/model/entity-cache.js';
import { EISDIR, ENOENT, ENOTEMPTY } from '@src/hal/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const MODEL_NAME = 'folder';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Database record type for folder detail table.
 *
 * Note: parent and pathname are in the entities table, not here.
 */
interface FolderRecord extends DbRecord {
    /** Owner process or user ID */
    owner: string;
}

/**
 * Schema definition for folder entities.
 *
 * Note: id, parent, pathname are in the entities table (handled by Ring 5).
 * These are the detail table fields only.
 */
const FOLDER_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Convert SQL timestamp string to milliseconds since epoch.
 */
function timestampToMs(isoString: string): number {
    return new Date(isoString).getTime();
}

/**
 * Merge entity and detail (from SQL) into ModelStat.
 * Accepts either CachedEntity (from cache) or ModelStat (from HAL storage).
 */
function mergeToStat(
    entity: CachedEntity | ModelStat,
    detail: FolderRecord
): ModelStat {
    // Handle both CachedEntity (has pathname) and ModelStat (has name)
    const name = 'pathname' in entity
        ? (entity as CachedEntity).pathname ?? ''
        : (entity as ModelStat).name;
    return {
        id: entity.id,
        model: entity.model,
        name,
        parent: entity.parent,
        owner: detail.owner,
        size: 0, // Folders have no size
        mtime: timestampToMs(detail.updated_at),
        ctime: timestampToMs(detail.created_at),
    };
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * FolderModel - Directory container model (entity-backed).
 *
 * Implements organizational hierarchy for the VFS. Folders contain
 * other entities (files, folders, devices) via parent-pointer relationship.
 *
 * Data flow:
 * - Entity identity (id, model, parent, pathname) → EntityCache
 * - Detail data (timestamps, owner) → SQL via DatabaseOps
 */
export class FolderModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    readonly name = MODEL_NAME;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    private readonly db: DatabaseOps;
    private readonly entityCache: EntityCache;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(db: DatabaseOps, entityCache: EntityCache) {
        super();
        this.db = db;
        this.entityCache = entityCache;
    }

    // =========================================================================
    // SCHEMA
    // =========================================================================

    fields(): FieldDef[] {
        return FOLDER_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open a folder for I/O operations.
     *
     * @throws EISDIR - Always (folders cannot be opened for I/O)
     */
    async open(
        _ctx: ModelContext,
        _id: string,
        _flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        throw new EISDIR('Cannot open folder for I/O');
    }

    /**
     * Get metadata for a folder.
     *
     * Handles two cases:
     * 1. Entity-backed folders: HAL entity + SQL detail
     * 2. Bootstrap folders (root, /dev): HAL entity only (no SQL detail)
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        // Get entity from HAL storage (dual-write target)
        const entity = await ctx.getEntity(id);
        if (!entity) {
            throw new ENOENT(`Folder not found: ${id}`);
        }

        // Try to get detail from SQL
        let detail: FolderRecord | null = null;
        for await (const r of this.db.selectAny<FolderRecord>(MODEL_NAME, {
            where: { id },
            limit: 1,
        })) {
            detail = r;
            break;
        }

        // If no SQL detail (bootstrap folders like root, /dev), use HAL entity data
        if (!detail) {
            return entity;
        }

        return mergeToStat(entity, detail);
    }

    /**
     * Update metadata fields on a folder.
     */
    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        // Get entity from HAL storage (dual-write target)
        const entity = await ctx.getEntity(id);
        if (!entity) {
            throw new ENOENT(`Folder not found: ${id}`);
        }

        // Build changes object
        const changes: Record<string, unknown> = {};
        if (fields.name !== undefined) changes.pathname = fields.name;
        if (fields.parent !== undefined) changes.parent = fields.parent;

        // Update via DatabaseOps
        for await (const _ of this.db.updateAll<FolderRecord>(MODEL_NAME, [
            { id, changes },
        ])) {
            // Record updated
        }

        // DUAL-WRITE: Update HAL storage (for VFS.getEntity())
        const updatedEntity: ModelStat = {
            ...entity,
            name: fields.name ?? entity.name,
            parent: fields.parent ?? entity.parent,
            mtime: ctx.hal.clock.now(),
        };
        await ctx.hal.storage.put(
            `entity:${id}`,
            new TextEncoder().encode(JSON.stringify(updatedEntity))
        );

        // Update EntityCache (for listChildren/getChild)
        if (fields.name !== undefined || fields.parent !== undefined) {
            this.entityCache.updateEntity(id, {
                pathname: fields.name,
                parent: fields.parent,
            });
        }
    }

    /**
     * Create a new folder.
     *
     * DUAL-WRITE: Creates entity in both SQL (via DatabaseOps) and HAL storage.
     * HAL storage write is needed because VFS.getEntity() looks there for
     * entity metadata during path resolution and mkdir recursive checks.
     */
    async create(
        ctx: ModelContext,
        parent: string,
        pathname: string,
        fields?: Partial<ModelStat>
    ): Promise<string> {
        let createdId: string | null = null;
        let createdAt: string | null = null;

        for await (const created of this.db.createAll<FolderRecord>(MODEL_NAME, [
            {
                pathname,
                parent: parent || null,
                owner: fields?.owner ?? ctx.caller,
            } as FolderRecord & { pathname: string; parent: string | null },
        ])) {
            createdId = created.id;
            createdAt = created.created_at;
            break;
        }

        if (!createdId) {
            throw new Error('Failed to create folder entity');
        }

        // DUAL-WRITE: Also store entity in HAL for VFS path resolution
        const now = createdAt ? timestampToMs(createdAt) : ctx.hal.clock.now();
        const stat: ModelStat = {
            id: createdId,
            model: MODEL_NAME,
            name: pathname,
            parent: parent || null,
            owner: fields?.owner ?? ctx.caller,
            size: 0,
            mtime: now,
            ctime: now,
        };
        await ctx.hal.storage.put(
            `entity:${createdId}`,
            new TextEncoder().encode(JSON.stringify(stat))
        );

        // Update EntityCache so listChildren() works
        this.entityCache.addEntity({
            id: createdId,
            model: MODEL_NAME,
            parent: parent || null,
            pathname,
        });

        return createdId;
    }

    /**
     * Delete a folder.
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        // Get entity from HAL storage (dual-write target)
        const entity = await ctx.getEntity(id);
        if (!entity) {
            throw new ENOENT(`Folder not found: ${id}`);
        }

        // Check if folder is empty using EntityCache
        // Note: EntityCache may not be fully populated for newly created entities,
        // but that's okay - we're checking for existing children
        const children = this.entityCache.listChildren(id);
        if (children.length > 0) {
            throw new ENOTEMPTY(`Folder not empty: ${id}`);
        }

        // Delete via DatabaseOps (soft delete)
        for await (const _ of this.db.deleteAll<FolderRecord>(MODEL_NAME, [{ id }])) {
            // Folder deleted
        }

        // Delete entity from HAL storage (dual-write cleanup)
        try {
            await ctx.hal.storage.delete(`entity:${id}`);
        } catch {
            // Entity may not exist in HAL - that's fine
        }
    }

    /**
     * List children of a folder.
     */
    async *list(_ctx: ModelContext, id: string): AsyncIterable<string> {
        // Use EntityCache for efficient child lookup
        const children = this.entityCache.listChildren(id);
        for (const childId of children) {
            yield childId;
        }
    }

    // =========================================================================
    // WATCH SUPPORT
    // =========================================================================

    /**
     * Watch for changes to children of a folder.
     *
     * Note: Currently watches HAL storage events for blob changes.
     * SQL metadata changes are not directly observable via this mechanism.
     */
    override async *watch(
        ctx: ModelContext,
        id: string,
        _pattern?: string
    ): AsyncIterable<WatchEvent> {
        // Watch for blob changes (limited - doesn't catch SQL metadata changes)
        const blobPattern = `blob:*:*`;

        for await (const event of ctx.hal.storage.watch(blobPattern)) {
            // Extract entity ID from blob key (format: blob:model:id)
            const parts = event.key.split(':');
            if (parts.length !== 3) continue;

            const entityId = parts[2]!;
            const entity = this.entityCache.getEntity(entityId);

            // Only emit events for direct children of this folder
            if (entity && entity.parent === id) {
                yield {
                    entity: entityId,
                    op: event.op === 'put' ? 'update' : 'delete',
                    path: await ctx.computePath(entityId),
                    timestamp: event.timestamp,
                };
            }
        }
    }
}
