/**
 * EntityModel - Polymorphic VFS model backed by entities table
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EntityModel provides a unified VFS interface for all entity types stored in
 * the `entities` table. Unlike model-specific implementations (FileModel,
 * FolderModel), EntityModel dispatches to the correct detail table based on
 * the entity's `model` field from PathCache.
 *
 * This enables polymorphic hierarchy where any VFS-addressable model can exist
 * at any path. A folder can contain files, users, configs, devices - whatever
 * has an entry in the entities table.
 *
 * TWO-TABLE ARCHITECTURE
 * ======================
 * ```
 * PathCache.resolvePath("/home/ian/settings.json")
 *     │
 *     └── returns { id, model: 'config', parent, pathname }
 *                        │
 *     ┌──────────────────┘
 *     │
 *     ├── stat()  ──► SELECT * FROM config WHERE id = ?
 *     ├── setstat() ──► UPDATE config SET ... WHERE id = ?
 *     └── create() ──► INSERT INTO entities + INSERT INTO config
 * ```
 *
 * The `entities` table owns identity (id, model, parent, pathname).
 * Detail tables own timestamps and model-specific fields.
 *
 * INVARIANTS
 * ==========
 * INV-1: Every entity has a row in both `entities` and its detail table
 * INV-2: entity.model determines which detail table to query
 * INV-3: PathCache is the source of truth for path resolution
 * INV-4: Detail tables are queried by id (primary key), not by path
 *
 * @module vfs/models/entity
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/vfs/handle.js';
import type { PathCache, PathEntry } from '@src/vfs/path-cache.js';
import type { EntityOps, EntityRecord } from '@src/ems/entity-ops.js';
import { ENOENT, EBADF, EACCES, EINVAL, ENOSYS } from '@src/hal/index.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get first result from async generator, or null if empty.
 */
async function first<T>(gen: AsyncIterable<T>): Promise<T | null> {
    for await (const item of gen) {
        return item;
    }

    return null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Storage key prefix for raw data blobs.
 * WHY: Allows data to be stored/retrieved independently of metadata.
 */
const DATA_PREFIX = 'data:';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for entity model.
 *
 * These are the common fields across all VFS entities.
 * Model-specific fields come from the detail table schema.
 */
const ENTITY_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'pathname', type: 'string', required: true },
    { name: 'created_at', type: 'string' },
    { name: 'updated_at', type: 'string' },
    { name: 'trashed_at', type: 'string' },
    { name: 'owner', type: 'string', required: true },
];

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * EntityModel - Polymorphic VFS model for entities table.
 *
 * Handles all VFS operations by:
 * 1. Using PathCache for path resolution (id + model)
 * 2. Querying the correct detail table based on entity.model
 * 3. Using HAL for blob storage
 */
export class EntityModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY 'entity': This is a meta-model that dispatches to other models.
     * The VFS can register this single model to handle all entity types.
     * Subclasses (FileModel, FolderModel) override with their specific type.
     */
    readonly name: string = 'entity';

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Path cache for path resolution.
     */
    private readonly cache: PathCache;

    /**
     * Entity operations for detail table queries.
     */
    private readonly db: EntityOps;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create an EntityModel.
     *
     * @param cache - PathCache for path resolution
     * @param db - EntityOps for detail table queries
     */
    constructor(cache: PathCache, db: EntityOps) {
        super();
        this.cache = cache;
        this.db = db;
    }

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for entities.
     *
     * WHY: Returns common entity fields. Model-specific fields
     * would need to be looked up from the fields table.
     */
    fields(): FieldDef[] {
        return ENTITY_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open an entity for I/O operations.
     *
     * ALGORITHM:
     * 1. Get entity from cache (for model type)
     * 2. Load detail from correct table
     * 3. Load blob data if entity has content
     * 4. Create and return EntityHandleImpl
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param flags - Open flags
     * @param opts - Open options
     * @returns FileHandle for I/O
     * @throws ENOENT if entity not found
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        opts?: OpenOptions,
    ): Promise<FileHandle> {
        // Get entity from cache
        const entity = this.cache.getEntry(id);

        if (!entity) {
            throw new ENOENT(`Entity not found: ${id}`);
        }

        // Load detail from model's table
        const detail = await first(
            this.db.selectAny<EntityRecord>(entity.model, { where: { id } }),
        );

        if (!detail) {
            throw new ENOENT(`Detail not found for entity: ${id}`);
        }

        // Merge entity + detail for stat
        // entities.pathname → ModelStat.name (VFS interface uses 'name')
        const stat = {
            ...detail,
            id: entity.id,
            model: entity.model,
            parent: entity.parent,
            name: entity.pathname,
        } as unknown as ModelStat;

        // Load blob content if this is a file-like entity
        let content: Uint8Array = new Uint8Array(0);

        if ('data' in detail && detail.data) {
            const blobData = await ctx.hal.storage.get(`${DATA_PREFIX}${detail.data}`);

            content = blobData ? new Uint8Array(blobData) : new Uint8Array(0);
        }

        // Truncate if requested
        if (flags.truncate && flags.write) {
            content = new Uint8Array(0);
        }

        return new EntityHandleImpl(ctx, this.db, entity, stat, content, flags, opts);
    }

    /**
     * Get metadata for an entity.
     *
     * ALGORITHM:
     * 1. Get entity from cache (id, model, parent, pathname)
     * 2. Query detail table for timestamps + model fields
     * 3. Merge and return
     *
     * @param _ctx - Model context (unused)
     * @param id - Entity UUID
     * @returns Combined entity + detail metadata
     * @throws ENOENT if not found
     */
    async stat(_ctx: ModelContext, id: string): Promise<ModelStat> {
        // Get entity from cache
        const entity = this.cache.getEntry(id);

        if (!entity) {
            throw new ENOENT(`Entity not found: ${id}`);
        }

        // Query detail table
        const detail = await first(
            this.db.selectAny<EntityRecord>(entity.model, { where: { id } }),
        );

        if (!detail) {
            throw new ENOENT(`Detail not found for entity: ${id}`);
        }

        // Merge entity + detail
        // Map EMS fields to VFS ModelStat fields
        const rec = detail as Record<string, unknown>;
        const updatedAt = rec.updated_at as string | undefined;
        const createdAt = rec.created_at as string | undefined;

        return {
            ...detail,
            id: entity.id,
            model: entity.model,
            parent: entity.parent,
            name: entity.pathname,
            // Map EMS timestamps to VFS format (milliseconds)
            mtime: updatedAt ? new Date(updatedAt).getTime() : Date.now(),
            ctime: createdAt ? new Date(createdAt).getTime() : Date.now(),
            // Default size for models without it (folders)
            size: (rec.size as number) ?? 0,
        } as unknown as ModelStat;
    }

    /**
     * Update metadata fields on an entity.
     *
     * ALGORITHM:
     * 1. Get entity from cache
     * 2. Separate entity fields (parent) from detail fields
     * 3. Update entities table if parent changed
     * 4. Update detail table for other fields
     *
     * @param _ctx - Model context (unused)
     * @param id - Entity UUID
     * @param fields - Fields to update
     * @throws ENOENT if not found
     */
    async setstat(_ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const entity = this.cache.getEntry(id);

        if (!entity) {
            throw new ENOENT(`Entity not found: ${id}`);
        }

        // Map VFS fields to EMS fields
        // VFS uses 'name', EMS uses 'pathname'
        const emsFields: Record<string, unknown> = { ...fields };

        if ('name' in emsFields) {
            emsFields.pathname = emsFields.name;
            delete emsFields.name;
        }

        // Update detail table (flows through observer pipeline)
        // The observer pipeline handles:
        // - Updating entities.parent if parent changed
        // - Updating entities.pathname if pathname source field changed
        // - Updating PathCache
        // Consume the generator to execute the update
        for await (const _ of this.db.updateIds(entity.model, [id], emsFields)) {
            // Consume results
        }
    }

    /**
     * Create a new entity.
     *
     * ALGORITHM:
     * 1. Generate UUID
     * 2. Determine model from fields or default
     * 3. INSERT into entities table
     * 4. INSERT into detail table
     *
     * Note: This requires knowing the model type. For EntityModel,
     * the model should be specified in fields.model.
     *
     * @param ctx - Model context
     * @param parent - Parent entity UUID
     * @param pathname - Entity pathname
     * @param fields - Initial fields (must include 'model')
     * @returns Created entity UUID
     */
    async create(
        ctx: ModelContext,
        parent: string,
        pathname: string,
        fields?: Partial<ModelStat>,
    ): Promise<string> {
        const model = fields?.model;

        if (!model) {
            throw new EINVAL('EntityModel.create requires fields.model');
        }

        const id = ctx.hal.entropy.uuid();

        // Create through DatabaseOps (observer pipeline handles entities + detail)
        // Consume the generator to execute the create
        for await (const _ of this.db.createAll(model, [{
            id,
            parent,
            pathname,
            owner: fields?.owner ?? ctx.caller,
            ...fields,
        }])) {
            // Consume results
        }

        return id;
    }

    /**
     * Delete an entity.
     *
     * @param _ctx - Model context (unused)
     * @param id - Entity UUID
     * @throws ENOENT if not found
     */
    async unlink(_ctx: ModelContext, id: string): Promise<void> {
        const entity = this.cache.getEntry(id);

        if (!entity) {
            throw new ENOENT(`Entity not found: ${id}`);
        }

        // Delete through DatabaseOps (observer pipeline handles both tables)
        // Consume the generator to execute the delete
        for await (const _ of this.db.deleteIds(entity.model, [id])) {
            // Consume results
        }
    }

    /**
     * List children of an entity.
     *
     * Uses PathCache.listChildren for O(1) lookup.
     *
     * @param _ctx - Model context (unused)
     * @param id - Parent entity UUID
     * @yields Child entity UUIDs
     */
    async *list(_ctx: ModelContext, id: string): AsyncIterable<string> {
        const children = this.cache.listChildren(id);

        for (const childId of children) {
            yield childId;
        }
    }

    // =========================================================================
    // WATCH SUPPORT
    // =========================================================================

    /**
     * Watch for changes to an entity.
     *
     * TODO: Implement watch support
     */
    override async *watch(
        _ctx: ModelContext,
        _id: string,
        _pattern?: string,
    ): AsyncIterable<WatchEvent> {
        throw new ENOSYS('EntityModel.watch not yet implemented');
    }
}

// =============================================================================
// ENTITY HANDLE IMPLEMENTATION
// =============================================================================

/**
 * EntityHandleImpl - File handle for entity I/O operations.
 *
 * Provides buffered read/write access. Content is loaded into memory
 * on construction and written back on close() or sync().
 */
class EntityHandleImpl implements FileHandle {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    readonly id: string;
    readonly path: string = '';
    readonly flags: OpenFlags;

    // =========================================================================
    // STATE
    // =========================================================================

    private _closed = false;
    private position = 0;
    private content: Uint8Array;
    private dirty = false;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    private readonly ctx: ModelContext;
    private readonly db: EntityOps;
    private readonly entity: PathEntry;
    private stat: ModelStat;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(
        ctx: ModelContext,
        db: EntityOps,
        entity: PathEntry,
        stat: ModelStat,
        content: Uint8Array,
        flags: OpenFlags,
        _opts?: OpenOptions,
    ) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.db = db;
        this.entity = entity;
        this.stat = stat;
        this.content = content;
        this.flags = flags;

        if (flags.append) {
            this.position = content.length;
        }
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    async read(size?: number): Promise<Uint8Array> {
        if (this._closed) {
            throw new EBADF('Handle closed');
        }

        if (!this.flags.read) {
            throw new EACCES('Handle not opened for reading');
        }

        const remaining = this.content.length - this.position;
        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;

        if (toRead <= 0) {
            return new Uint8Array(0);
        }

        const result = this.content.slice(this.position, this.position + toRead);

        this.position += toRead;

        return result;
    }

    // =========================================================================
    // WRITE OPERATIONS
    // =========================================================================

    async write(data: Uint8Array): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle closed');
        }

        if (!this.flags.write) {
            throw new EACCES('Handle not opened for writing');
        }

        if (this.flags.append) {
            this.position = this.content.length;
        }

        const endPos = this.position + data.length;

        if (endPos > this.content.length) {
            const newContent = new Uint8Array(endPos);

            newContent.set(this.content);
            this.content = newContent;
        }

        this.content.set(data, this.position);
        this.position = endPos;
        this.dirty = true;

        return data.length;
    }

    // =========================================================================
    // POSITION OPERATIONS
    // =========================================================================

    async seek(offset: number, whence: SeekWhence): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle closed');
        }

        let newPos: number;

        switch (whence) {
            case 'start':
                newPos = offset;
                break;
            case 'current':
                newPos = this.position + offset;
                break;
            case 'end':
                newPos = this.content.length + offset;
                break;
            default:
                throw new EINVAL(`Invalid whence: ${whence}`);
        }

        if (newPos < 0) {
            throw new EINVAL('Seek position cannot be negative');
        }

        this.position = newPos;

        return this.position;
    }

    async tell(): Promise<number> {
        return this.position;
    }

    // =========================================================================
    // FLUSH OPERATIONS
    // =========================================================================

    async sync(): Promise<void> {
        if (this._closed) {
            throw new EBADF('Handle closed');
        }

        if (!this.dirty) {
            return;
        }

        await this.flush();
    }

    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        if (this.dirty) {
            await this.flush();
        }

        this._closed = true;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    private async flush(): Promise<void> {
        // Write blob data
        if (this.stat.data) {
            await this.ctx.hal.storage.put(`${DATA_PREFIX}${this.stat.data}`, this.content);
        }

        // Update detail table (size, updated_at via observer)
        // Consume the generator to execute the update
        for await (const _ of this.db.updateIds(this.entity.model, [this.entity.id], {
            size: this.content.length,
        })) {
            // Consume results
        }

        this.dirty = false;
    }
}
