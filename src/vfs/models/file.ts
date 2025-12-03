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
import { ENOENT, EBADF, EACCES, EINVAL } from '@src/hal/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Storage key prefix for entity metadata.
 * WHY: Separates entity namespace from data namespace in storage.
 */
const ENTITY_PREFIX = 'entity:';

/**
 * Storage key prefix for raw data blobs.
 * WHY: Allows data to be stored/retrieved independently of metadata.
 */
const DATA_PREFIX = 'data:';

/**
 * Storage key prefix for access control lists.
 * WHY: ACLs are stored separately to allow efficient permission checks.
 */
const ACCESS_PREFIX = 'access:';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Schema definition for file entities.
 *
 * TESTABILITY: Exported constant allows tests to verify schema structure.
 *
 * Fields:
 * - id: UUID of the file entity
 * - model: Always 'file' for this model
 * - name: Filename (not full path)
 * - parent: UUID of parent folder
 * - data: UUID of the data blob
 * - owner: UUID of creating process/user
 * - size: Byte length of content
 * - mtime: Last modification timestamp
 * - ctime: Creation timestamp
 * - mimetype: Optional MIME type hint
 * - versioned: Whether version history is enabled
 * - version: Current version number (if versioned)
 */
const FILE_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'data', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'size', type: 'number', required: true },
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
    { name: 'mimetype', type: 'string' },
    { name: 'versioned', type: 'boolean' },
    { name: 'version', type: 'number' },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Decode a Uint8Array to a JSON object.
 *
 * WHY: Centralizes JSON deserialization with proper typing.
 *
 * @param data - Raw bytes to decode
 * @returns Parsed JSON object
 */
function decodeEntity<T>(data: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Encode a JSON object to a Uint8Array.
 *
 * WHY: Centralizes JSON serialization for storage.
 *
 * @param entity - Object to encode
 * @returns Encoded bytes
 */
function encodeEntity(entity: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(entity));
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * FileModel - Standard file storage model.
 *
 * Implements POSIX-style file operations backed by StorageEngine.
 * Files consist of an entity record (metadata) and a data blob (content).
 */
export class FileModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY: Used by VFS to dispatch operations to the correct model.
     * INVARIANT: Always 'file' for this model.
     */
    readonly name = 'file';

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for file entities.
     *
     * WHY: Enables schema validation and introspection.
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
     * 1. Load entity metadata from storage
     * 2. Load content from data blob (or empty if none)
     * 3. Apply truncate flag if requested
     * 4. Create and return FileHandleImpl
     *
     * RACE CONDITION:
     * Content is loaded once at open time. Concurrent opens get independent
     * snapshots. Last writer wins on close.
     *
     * @param ctx - Model context with HAL and caller info
     * @param id - Entity UUID to open
     * @param flags - Open flags (read/write/truncate/append)
     * @param opts - Optional open options (version selection)
     * @returns FileHandle for I/O operations
     * @throws ENOENT - If file does not exist
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        opts?: OpenOptions
    ): Promise<FileHandle> {
        // Load entity metadata
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);

        // Load current content from data blob
        let content: Uint8Array;
        if (entity.data) {
            const blobData = await ctx.hal.storage.get(`${DATA_PREFIX}${entity.data}`);
            // Data blob may not exist if file was just created
            content = blobData ?? new Uint8Array(0);
        } else {
            content = new Uint8Array(0);
        }

        // Truncate if requested (requires write permission)
        if (flags.truncate && flags.write) {
            content = new Uint8Array(0);
        }

        return new FileHandleImpl(ctx, id, entity, content, flags, opts);
    }

    /**
     * Get metadata for a file.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata
     * @throws ENOENT - If file does not exist
     */
    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        return decodeEntity<ModelStat>(data);
    }

    /**
     * Update metadata fields on a file.
     *
     * ALGORITHM:
     * 1. Load existing entity
     * 2. Merge allowed fields
     * 3. Update mtime
     * 4. Write back to storage
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update
     * @throws ENOENT - If file does not exist
     */
    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);

        // Update allowed fields only (name, parent, mimetype, versioned)
        // WHY: Prevents modification of internal fields like id, model, ctime
        if (fields.name !== undefined) entity.name = fields.name;
        if (fields.parent !== undefined) entity.parent = fields.parent;
        if (fields.mimetype !== undefined) entity.mimetype = fields.mimetype;
        if (fields.versioned !== undefined) entity.versioned = fields.versioned;

        // Always update mtime on metadata change
        entity.mtime = ctx.hal.clock.now();

        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));
    }

    /**
     * Create a new file.
     *
     * ALGORITHM:
     * 1. Generate UUIDs for entity and data blob
     * 2. Create empty data blob
     * 3. Create entity with metadata
     * 4. Return entity UUID
     *
     * WHY data blob is created first:
     * If we crash after creating entity but before data blob, the entity
     * would reference a non-existent blob. Creating blob first means an
     * orphaned blob (worst case) rather than a broken entity reference.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param name - Filename
     * @param fields - Optional initial field values
     * @returns Created entity UUID
     */
    async create(
        ctx: ModelContext,
        parent: string,
        name: string,
        fields?: Partial<ModelStat>
    ): Promise<string> {
        const id = ctx.hal.entropy.uuid();
        const dataId = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();

        const entity: ModelStat = {
            id,
            model: 'file',
            name,
            parent,
            data: dataId,
            owner: fields?.owner ?? ctx.caller,
            size: 0,
            mtime: now,
            ctime: now,
            mimetype: fields?.mimetype,
            versioned: fields?.versioned,
            version: fields?.versioned ? 1 : undefined,
        };

        // Create empty data blob first (see WHY above)
        await ctx.hal.storage.put(`${DATA_PREFIX}${dataId}`, new Uint8Array(0));

        // Create entity metadata
        await ctx.hal.storage.put(`${ENTITY_PREFIX}${id}`, encodeEntity(entity));

        return id;
    }

    /**
     * Delete a file.
     *
     * ALGORITHM:
     * 1. Load entity to get data blob reference
     * 2. Delete data blob
     * 3. Delete entity
     * 4. Delete ACL (if exists)
     *
     * WHY this order:
     * Deleting data blob first prevents orphaned data. If crash occurs
     * after blob deletion, entity still exists but points to nothing -
     * subsequent access will fail cleanly with ENOENT on the blob.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to delete
     * @throws ENOENT - If file does not exist
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        const data = await ctx.hal.storage.get(`${ENTITY_PREFIX}${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        const entity = decodeEntity<ModelStat>(data);

        // Delete data blob first (see WHY above)
        if (entity.data) {
            await ctx.hal.storage.delete(`${DATA_PREFIX}${entity.data}`);
        }

        // Delete entity metadata
        await ctx.hal.storage.delete(`${ENTITY_PREFIX}${id}`);

        // Delete ACL (cleanup, may not exist)
        await ctx.hal.storage.delete(`${ACCESS_PREFIX}${id}`);
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
     * Subscribes to storage events for this file's entity key and
     * translates them to WatchEvents.
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
        // Watch for changes to this specific file's entity
        for await (const event of ctx.hal.storage.watch(`${ENTITY_PREFIX}${id}`)) {
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

    /**
     * Unique handle identifier.
     *
     * WHY: Enables handle tracking and revocation by kernel.
     */
    readonly id: string;

    /**
     * Path this handle was opened with.
     *
     * WHY: Required by FileHandle interface. Empty here because we open by ID.
     * INVARIANT: Always empty string for FileModel handles.
     */
    readonly path: string = '';

    /**
     * Open flags.
     *
     * WHY: Determines what operations are permitted on this handle.
     * INVARIANT: Immutable after construction.
     */
    readonly flags: OpenFlags;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Whether handle has been closed.
     *
     * WHY: Prevents I/O on closed handles.
     * INVARIANT: Once true, never becomes false again.
     */
    private _closed = false;

    /**
     * Current read/write position in bytes.
     *
     * WHY: POSIX semantics require tracking position for sequential I/O.
     * INVARIANT: Always >= 0.
     */
    private position = 0;

    /**
     * In-memory content buffer.
     *
     * WHY: Enables random access without repeated storage calls.
     * Memory is traded for I/O efficiency.
     */
    private content: Uint8Array;

    /**
     * Whether content has been modified since last flush.
     *
     * WHY: Avoids unnecessary storage writes on close().
     * INVARIANT: True IFF content differs from what's in storage.
     */
    private dirty = false;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Model context for HAL access.
     *
     * WHY: Needed for storage operations and clock access.
     */
    private readonly ctx: ModelContext;

    /**
     * Entity UUID.
     *
     * WHY: Identifies the entity in storage for metadata updates.
     */
    private readonly entityId: string;

    /**
     * Entity metadata (mutable copy).
     *
     * WHY: Updated on flush to reflect new size/mtime.
     */
    private entity: ModelStat;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new FileHandleImpl.
     *
     * @param ctx - Model context for HAL access
     * @param entityId - Entity UUID
     * @param entity - Entity metadata
     * @param content - Initial content buffer
     * @param flags - Open flags
     * @param _opts - Open options (currently unused)
     */
    constructor(
        ctx: ModelContext,
        entityId: string,
        entity: ModelStat,
        content: Uint8Array,
        flags: OpenFlags,
        _opts?: OpenOptions
    ) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.entityId = entityId;
        this.entity = entity;
        this.content = content;
        this.flags = flags;

        // Append mode: start position at end of content
        // WHY: POSIX append semantics require writes to always go at EOF
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
     * 1. Write data blob to storage
     * 2. Update entity metadata (size, mtime)
     * 3. Write entity to storage
     * 4. Clear dirty flag
     *
     * WHY data is written before entity:
     * If crash occurs between writes, entity will reference old data
     * (safe but stale) rather than new entity referencing non-existent
     * data (broken).
     */
    private async flush(): Promise<void> {
        const now = this.ctx.hal.clock.now();

        // Write data blob first (see WHY above)
        await this.ctx.hal.storage.put(`${DATA_PREFIX}${this.entity.data}`, this.content);

        // Update entity metadata
        this.entity.size = this.content.length;
        this.entity.mtime = now;

        // Write entity metadata
        await this.ctx.hal.storage.put(
            `${ENTITY_PREFIX}${this.entityId}`,
            encodeEntity(this.entity)
        );

        this.dirty = false;
    }
}
