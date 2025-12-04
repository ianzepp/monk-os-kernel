/**
 * FileModel - Standard file storage backed by StorageEngine
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FileModel implements the POSIX file abstraction for Monk OS. Each file consists
 * of two storage entries: an entity record containing metadata (JSON) and a data
 * blob containing raw bytes. This separation enables efficient metadata queries
 * without loading file content.
 *
 * Files are identified by UUIDs. The entity record stores the file's name, parent
 * folder UUID, owner, size, timestamps, and a reference to its data blob. This
 * design mirrors traditional inode-based filesystems where metadata is stored
 * separately from data blocks.
 *
 * FileHandleImpl provides a buffered I/O interface. Content is loaded into memory
 * on open() and written back on close() or sync(). This simplifies the
 * implementation but means files are limited by available memory. Large file
 * support would require chunked streaming.
 *
 * STATE MACHINE (FileHandle)
 * ==========================
 *
 *   open() ──────────> OPEN ──────────> CLOSED
 *                       │                  ^
 *                       │ (any error)      │
 *                       └──────────────────┘
 *                              close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: entity.data always references a valid data blob (or null for empty)
 * INV-2: entity.size always equals the actual byte length of the data blob
 * INV-3: position is always >= 0 and can exceed content.length (sparse writes)
 * INV-4: dirty flag is true IFF in-memory content differs from storage
 * INV-5: Once closed, no further I/O operations are permitted
 * INV-6: ctime is set once at creation and never modified
 * INV-7: mtime is updated on any data or metadata modification
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * handles to the same file are independent - each loads its own copy of content
 * on open(). This provides snapshot isolation but means concurrent writers will
 * have last-write-wins semantics.
 *
 * The storage engine provides atomic put/get/delete operations. Entity and data
 * blob updates are NOT atomic with respect to each other - a crash between
 * updating data and entity could leave them inconsistent. Production systems
 * should consider journaling or transactional storage.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle closure check before every I/O operation
 * RC-2: Dirty flag prevents redundant flushes and ensures write ordering
 * RC-3: Each handle has independent content buffer - no shared mutable state
 *
 * MEMORY MANAGEMENT
 * =================
 * - File content is fully loaded into memory on open()
 * - Content buffer grows dynamically on write()
 * - Buffer is released on close() (GC handles actual deallocation)
 * - Callers should use `await using` pattern for automatic cleanup
 *
 * @module vfs/models/file
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/vfs/handle.js';
import type { DatabaseOps, DbRecord } from '@src/model/database-ops.js';
import type { EntityCache, CachedEntity } from '@src/model/entity-cache.js';
import { ENOENT, EBADF, EACCES, EINVAL } from '@src/hal/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Database record type for blob-backed model detail tables.
 *
 * WHY: Common fields across all blob-backed models (file, temp, audio, etc.).
 * Model-specific fields (like audio.artist) are in the DB schema, not here.
 *
 * Note: parent and pathname are in the entities table, not here.
 */
interface BlobRecord extends DbRecord {
    /** Owner process or user ID */
    owner: string;

    /** Blob size in bytes */
    size: number;

    /** MIME type */
    mimetype: string | null;
}

/**
 * Schema definition for blob-backed file entities.
 *
 * Note: id, parent, pathname are in the entities table (handled by Ring 5).
 * These are the common detail table fields for blob-backed models.
 */
const FILE_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'size', type: 'number' },
    { name: 'mimetype', type: 'string' },
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
 *
 * WHY: Entity+detail architecture splits data across two sources:
 * - EntityCache/HAL: id, model, parent, pathname/name
 * - Detail table: timestamps, owner, size, mimetype
 */
function mergeToStat(
    entity: CachedEntity | ModelStat,
    detail: BlobRecord
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
        size: detail.size ?? 0,
        mtime: timestampToMs(detail.updated_at),
        ctime: timestampToMs(detail.created_at),
        mimetype: detail.mimetype ?? undefined,
    };
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * FileModel - Generic blob-backed file storage model.
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * FileModel is the universal handler for all blob-backed entities:
 * - file (standard files)
 * - temp (temporary files)
 * - audio, video, image, document (future media types)
 *
 * The model is determined by entity.model from EntityCache, NOT hardcoded.
 * This enables one model class to handle any blob-backed entity type.
 *
 * Data flow:
 * - Entity identity (id, model, parent, pathname) → EntityCache
 * - Detail data (timestamps, owner, size, mimetype) → SQL via DatabaseOps
 * - Blob content → HAL storage at key `blob:{model}:{id}`
 */
export class FileModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY: Used by VFS for registration. Actual model is determined per-entity
     * from EntityCache (entity.model field).
     */
    readonly name = 'file';

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Database operations interface.
     *
     * WHY: All SQL operations go through DatabaseOps for observer pipeline.
     */
    private readonly db: DatabaseOps;

    /**
     * Entity cache for path resolution and entity metadata.
     *
     * WHY: Entity+detail architecture stores id, model, parent, pathname
     * in the entities table. EntityCache provides O(1) access.
     */
    private readonly entityCache: EntityCache;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new FileModel instance.
     *
     * @param db - DatabaseOps instance for SQL operations
     * @param entityCache - EntityCache for entity metadata
     */
    constructor(db: DatabaseOps, entityCache: EntityCache) {
        super();
        this.db = db;
        this.entityCache = entityCache;
    }

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for blob-backed entities.
     *
     * WHY: Enables schema validation and introspection.
     * Note: These are common fields. Model-specific fields are in DB schema.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[] {
        return FILE_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open a file for I/O operations.
     *
     * ALGORITHM:
     * 1. Get entity from EntityCache (id, model, parent, pathname)
     * 2. Load blob content from HAL storage
     * 3. Apply truncate flag if requested
     * 4. Create and return FileHandleImpl
     *
     * @param ctx - Model context with HAL and caller info
     * @param id - Entity UUID to open
     * @param flags - Open flags (read/write/truncate/append)
     * @param _opts - Optional open options (currently unused)
     * @returns FileHandle for I/O operations
     * @throws ENOENT - If file does not exist
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        // Get entity from HAL storage (dual-write target)
        // Use ctx.getEntity() instead of entityCache.getEntity() because
        // newly created entities are in HAL but not yet in the cache
        const entity = await ctx.getEntity(id);
        if (!entity) {
            throw new ENOENT(`File not found: ${id}`);
        }

        // Load blob content from HAL storage
        const blobKey = `blob:${entity.model}:${id}`;
        let content = await ctx.hal.storage.get(blobKey);
        content = content ?? new Uint8Array(0);

        // Truncate if requested (requires write permission)
        if (flags.truncate && flags.write) {
            content = new Uint8Array(0);
        }

        return new FileHandleImpl(ctx, this.db, entity.model, id, content, flags);
    }

    /**
     * Get metadata for a file.
     *
     * ALGORITHM:
     * 1. Get entity data from HAL storage (dual-write target)
     * 2. Get detail data from SQL (timestamps, owner, size, mimetype)
     * 3. Merge into ModelStat
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata
     * @throws ENOENT - If file does not exist
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        // Get entity from HAL storage (dual-write target)
        // Use ctx.getEntity() instead of entityCache because newly created
        // entities are in HAL but not yet in the cache
        const entity = await ctx.getEntity(id);
        if (!entity) {
            throw new ENOENT(`File not found: ${id}`);
        }

        // Get detail from SQL (query the model's detail table)
        let detail: BlobRecord | null = null;
        for await (const r of this.db.selectAny<BlobRecord>(entity.model, {
            where: { id },
            limit: 1,
        })) {
            detail = r;
            break;
        }

        if (!detail) {
            throw new ENOENT(`File detail not found: ${id}`);
        }

        return mergeToStat(entity, detail);
    }

    /**
     * Update metadata fields on a file.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update
     * @throws ENOENT - If file does not exist
     */
    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        // Get entity from HAL storage (dual-write target)
        const entity = await ctx.getEntity(id);
        if (!entity) {
            throw new ENOENT(`File not found: ${id}`);
        }

        // Build changes object
        // name→pathname and parent go to entities table (handled by Ring 5)
        // mimetype goes to detail table
        const changes: Record<string, unknown> = {};
        if (fields.name !== undefined) changes.pathname = fields.name;
        if (fields.parent !== undefined) changes.parent = fields.parent;
        if (fields.mimetype !== undefined) changes.mimetype = fields.mimetype ?? null;

        // Update via DatabaseOps (triggers observer pipeline)
        for await (const _ of this.db.updateAll<BlobRecord>(entity.model, [
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
     * Create a new file.
     *
     * DUAL-WRITE: Creates entity in both SQL (via DatabaseOps) and HAL storage.
     * HAL storage write is needed because VFS.getEntity() looks there for
     * entity metadata during path resolution.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param pathname - Filename (becomes entities.pathname)
     * @param fields - Optional initial field values
     * @param modelName - Model name (default: 'file')
     * @returns Created entity UUID
     */
    async create(
        ctx: ModelContext,
        parent: string,
        pathname: string,
        fields?: Partial<ModelStat>,
        modelName: string = 'file'
    ): Promise<string> {
        // Create entity via DatabaseOps
        // Ring 5 SqlCreate splits this into entities + detail tables
        let createdId: string | null = null;
        let createdAt: string | null = null;

        for await (const created of this.db.createAll<BlobRecord>(modelName, [
            {
                // Entity fields (go to entities table)
                pathname,
                parent: parent || null,
                // Detail fields (go to model's detail table)
                owner: fields?.owner ?? ctx.caller,
                size: 0,
                mimetype: (fields?.mimetype as string) ?? null,
            } as BlobRecord & { pathname: string; parent: string | null },
        ])) {
            createdId = created.id;
            createdAt = created.created_at;
            break;
        }

        if (!createdId) {
            throw new Error(`Failed to create ${modelName} entity`);
        }

        // Create empty blob in HAL storage
        const blobKey = `blob:${modelName}:${createdId}`;
        await ctx.hal.storage.put(blobKey, new Uint8Array(0));

        // DUAL-WRITE: Also store entity in HAL for VFS path resolution
        const now = createdAt ? timestampToMs(createdAt) : ctx.hal.clock.now();
        const stat: ModelStat = {
            id: createdId,
            model: modelName,
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
            model: modelName,
            parent: parent || null,
            pathname,
        });

        return createdId;
    }

    /**
     * Delete a file.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to delete
     * @throws ENOENT - If file does not exist
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        // Get entity from HAL storage (dual-write target)
        const entity = await ctx.getEntity(id);
        if (!entity) {
            throw new ENOENT(`File not found: ${id}`);
        }

        // Delete entity via DatabaseOps (soft delete through observer pipeline)
        for await (const _ of this.db.deleteAll<BlobRecord>(entity.model, [{ id }])) {
            // Entity deleted (soft delete sets trashed_at)
        }

        // Delete blob from HAL storage
        const blobKey = `blob:${entity.model}:${id}`;
        try {
            await ctx.hal.storage.delete(blobKey);
        } catch {
            // Blob may not exist - that's fine
        }

        // Delete entity from HAL storage (dual-write cleanup)
        try {
            await ctx.hal.storage.delete(`entity:${id}`);
        } catch {
            // Entity may not exist in HAL - that's fine
        }
    }

    /**
     * List children of a file.
     *
     * WHY: Files are leaf nodes and have no children.
     *
     * @returns Empty iterator
     */
    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Files don't have children - this is a no-op
        return;
    }

    // =========================================================================
    // WATCH SUPPORT
    // =========================================================================

    /**
     * Watch for changes to a file.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to watch
     * @param _pattern - Unused (files have no children to pattern-match)
     * @returns Stream of watch events
     */
    override async *watch(
        ctx: ModelContext,
        id: string,
        _pattern?: string
    ): AsyncIterable<WatchEvent> {
        const entity = this.entityCache.getEntity(id);
        if (!entity) return;

        // Watch for changes to this file's blob
        const blobKey = `blob:${entity.model}:${id}`;
        for await (const event of ctx.hal.storage.watch(blobKey)) {
            yield {
                entity: id,
                op: event.op === 'put' ? 'update' : 'delete',
                path: await ctx.computePath(id),
                timestamp: event.timestamp,
            };
        }
    }
}

// =============================================================================
// FILE HANDLE IMPLEMENTATION
// =============================================================================

/**
 * FileHandleImpl - File handle for I/O operations.
 *
 * Provides buffered read/write access to file content. Content is loaded
 * into memory on construction and written back on close() or sync().
 *
 * ARCHITECTURE:
 * - Blob data → HAL storage at key `blob:{model}:{id}`
 * - Size updates → SQL via DatabaseOps (triggers observer pipeline)
 *
 * INVARIANTS:
 * - Once _closed is true, all I/O methods throw EBADF
 * - dirty is true IFF content differs from storage
 * - position >= 0 always
 * - flags are immutable after construction
 */
class FileHandleImpl implements FileHandle {
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
    private readonly db: DatabaseOps;
    private readonly modelName: string;
    private readonly entityId: string;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new FileHandleImpl.
     *
     * @param ctx - Model context for HAL access
     * @param db - DatabaseOps for SQL operations
     * @param modelName - Model name (for blob key and detail table)
     * @param entityId - Entity UUID
     * @param content - Initial content buffer
     * @param flags - Open flags
     */
    constructor(
        ctx: ModelContext,
        db: DatabaseOps,
        modelName: string,
        entityId: string,
        content: Uint8Array,
        flags: OpenFlags
    ) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.db = db;
        this.modelName = modelName;
        this.entityId = entityId;
        this.content = content;
        this.flags = flags;

        // Append mode: start position at end of content
        if (flags.append) {
            this.position = content.length;
        }
    }

    // =========================================================================
    // STATE ACCESSORS
    // =========================================================================

    /**
     * Whether handle is closed.
     *
     * WHY: Exposes closure state for external checks.
     */
    get closed(): boolean {
        return this._closed;
    }

    // =========================================================================
    // READ OPERATIONS
    // =========================================================================

    /**
     * Read bytes from current position.
     *
     * ALGORITHM:
     * 1. Validate handle state
     * 2. Calculate bytes available from current position
     * 3. Slice content buffer
     * 4. Advance position
     *
     * @param size - Maximum bytes to read (default: remaining bytes)
     * @returns Bytes read (empty at EOF)
     * @throws EBADF - If handle is closed
     * @throws EACCES - If handle not opened for reading
     */
    async read(size?: number): Promise<Uint8Array> {
        // RACE FIX: Check closure state before any operation
        if (this._closed) {
            throw new EBADF('Handle closed');
        }
        if (!this.flags.read) {
            throw new EACCES('Handle not opened for reading');
        }

        const remaining = this.content.length - this.position;
        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;

        // At or past EOF
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

    /**
     * Write bytes at current position.
     *
     * ALGORITHM:
     * 1. Validate handle state
     * 2. Adjust position for append mode
     * 3. Expand content buffer if needed
     * 4. Copy data into buffer
     * 5. Advance position and set dirty flag
     *
     * WHY buffer expansion creates a new array:
     * Uint8Array is fixed-size. Growing requires allocating a new buffer
     * and copying existing data. This is O(n) but unavoidable without
     * more complex chunked storage.
     *
     * @param data - Bytes to write
     * @returns Number of bytes written (always data.length)
     * @throws EBADF - If handle is closed
     * @throws EACCES - If handle not opened for writing
     */
    async write(data: Uint8Array): Promise<number> {
        // RACE FIX: Check closure state before any operation
        if (this._closed) {
            throw new EBADF('Handle closed');
        }
        if (!this.flags.write) {
            throw new EACCES('Handle not opened for writing');
        }

        // Append mode: always write at end
        if (this.flags.append) {
            this.position = this.content.length;
        }

        // Expand content buffer if write would exceed current size
        const endPos = this.position + data.length;
        if (endPos > this.content.length) {
            const newContent = new Uint8Array(endPos);
            newContent.set(this.content);
            this.content = newContent;
        }

        // Copy data into content buffer
        this.content.set(data, this.position);
        this.position = endPos;
        this.dirty = true;

        return data.length;
    }

    // =========================================================================
    // POSITION OPERATIONS
    // =========================================================================

    /**
     * Seek to a position in the file.
     *
     * WHY position can exceed content length:
     * POSIX allows seeking past EOF. Subsequent writes will create a
     * sparse region (filled with zeros when buffer expands).
     *
     * @param offset - Byte offset from whence
     * @param whence - Reference point: 'start', 'current', or 'end'
     * @returns New absolute position
     * @throws EBADF - If handle is closed
     * @throws EINVAL - If whence is invalid or result would be negative
     */
    async seek(offset: number, whence: SeekWhence): Promise<number> {
        // RACE FIX: Check closure state before any operation
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

        // POSIX: seeking to negative position is an error
        if (newPos < 0) {
            throw new EINVAL('Seek position cannot be negative');
        }

        this.position = newPos;
        return this.position;
    }

    /**
     * Get current position.
     *
     * @returns Current byte offset
     */
    async tell(): Promise<number> {
        return this.position;
    }

    // =========================================================================
    // FLUSH OPERATIONS
    // =========================================================================

    /**
     * Flush pending writes to storage.
     *
     * @throws EBADF - If handle is closed
     */
    async sync(): Promise<void> {
        // RACE FIX: Check closure state before any operation
        if (this._closed) {
            throw new EBADF('Handle closed');
        }

        // No-op if nothing to flush
        if (!this.dirty) {
            return;
        }

        await this.flush();
    }

    /**
     * Close handle and flush pending writes.
     *
     * Safe to call multiple times - subsequent calls are no-ops.
     */
    async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        // Flush pending writes before closing
        if (this.dirty) {
            await this.flush();
        }

        this._closed = true;
    }

    /**
     * AsyncDisposable support for `await using` pattern.
     *
     * WHY: Ensures handles are closed even if exceptions occur.
     */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Write content and metadata to storage.
     *
     * ALGORITHM:
     * 1. Write blob to HAL storage
     * 2. Update size in detail table via DatabaseOps
     * 3. Clear dirty flag
     */
    private async flush(): Promise<void> {
        // Write blob to HAL storage
        const blobKey = `blob:${this.modelName}:${this.entityId}`;
        await this.ctx.hal.storage.put(blobKey, this.content);

        // Check state after await (handle may have been closed concurrently)
        if (this._closed) {
            return;
        }

        // Update size in detail table via DatabaseOps
        for await (const _ of this.db.updateAll<BlobRecord>(this.modelName, [
            { id: this.entityId, changes: { size: this.content.length } },
        ])) {
            // Size updated
        }

        // Check state after await
        if (this._closed) {
            return;
        }

        this.dirty = false;
    }
}
