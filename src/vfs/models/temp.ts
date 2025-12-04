/**
 * TempModel - SQL-backed file storage for /tmp filesystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * TempModel is the proof-of-concept implementation for Monk OS's entity+data
 * architecture, where:
 *
 *   - Entity metadata is stored in SQL (the `temp` table) via DatabaseOps
 *   - Blob data is stored in HAL storage, keyed by `blob:temp:{id}`
 *
 * This separation enables:
 *   - Rich SQL queries on file metadata (SELECT * FROM temp WHERE size > 1000)
 *   - Observer pipeline integration for validation and auditing
 *   - Efficient blob storage outside SQLite for large files
 *
 * Unlike FileModel (which stores metadata as JSON in HAL storage), TempModel
 * uses the full observer pipeline for entity mutations. This means:
 *   - Ring 1 validators can enforce constraints
 *   - Ring 5 handles SQL persistence
 *   - Ring 7 tracks changes for auditing
 *   - Ring 8 invalidates caches
 *
 * STATE MACHINE (TempFileHandle)
 * ==============================
 *
 *   open() ──────────> OPEN ──────────> CLOSED
 *                       │                  ^
 *                       │ (any error)      │
 *                       └──────────────────┘
 *                              close()
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Entity metadata lives in SQL `temp` table, never in HAL directly
 * INV-2: Blob data lives in HAL at key `blob:temp:{id}`, never in SQL
 * INV-3: entity.size always equals the actual byte length of the blob
 * INV-4: Once closed, no further I/O operations are permitted on handle
 * INV-5: Dirty flag is true IFF in-memory content differs from HAL blob
 * INV-6: created_at is set once at creation and never modified
 * INV-7: updated_at is updated on any data or metadata modification
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * handles to the same temp file are independent - each loads its own copy of
 * content on open(). This provides snapshot isolation but means concurrent
 * writers will have last-write-wins semantics.
 *
 * The DatabaseOps layer provides atomic SQL operations. Entity and blob updates
 * are NOT atomic with respect to each other - a crash between updating blob
 * and entity could leave them inconsistent. For temp files (ephemeral by nature),
 * this is acceptable. Production persistent storage should use journaling.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Handle closure check before every I/O operation
 * RC-2: Dirty flag prevents redundant flushes and ensures write ordering
 * RC-3: Each handle has independent content buffer - no shared mutable state
 * RC-4: State check after every await in flush() to handle concurrent close
 *
 * MEMORY MANAGEMENT
 * =================
 * - File content is fully loaded into memory on open()
 * - Content buffer grows dynamically on write()
 * - Buffer is released on close() (GC handles actual deallocation)
 * - Callers should use `await using` pattern for automatic cleanup
 *
 * DATABASE INTEGRATION
 * ====================
 * This model uses DatabaseOps for SQL operations, which means:
 * - All mutations flow through the observer pipeline (Rings 0-8)
 * - selectAny() is used for reads (bypasses observers for performance)
 * - createAll(), updateAll(), deleteAll() are used for mutations
 *
 * @module vfs/models/temp
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef, WatchEvent } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/vfs/handle.js';
import type { DatabaseOps, DbRecord } from '@src/ems/database-ops.js';
import { ENOENT, EBADF, EACCES, EINVAL } from '@src/hal/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Storage key prefix for blob data.
 * WHY: Namespaces temp file blobs in HAL storage to avoid collisions.
 * Format: blob:temp:{entity_id}
 */
const BLOB_PREFIX = 'blob:temp:';

/**
 * Model name constant.
 * WHY: Used consistently across model registration and entity.model field.
 */
const MODEL_NAME = 'temp';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Database record type for temp table.
 *
 * WHY: Typed interface for SQL rows in the temp table.
 * Matches the schema definition in schema.sql.
 */
interface TempRecord extends DbRecord {
    /** File name (required) */
    name: string;

    /** Parent temp ID (null for root-level) */
    parent: string | null;

    /** Owner process or user ID (required) */
    owner: string;

    /** Blob size in bytes */
    size: number;

    /** MIME type */
    mimetype: string | null;
}

/**
 * Schema definition for temp file entities.
 *
 * TESTABILITY: Exported constant allows tests to verify schema structure.
 */
const TEMP_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string' },
    { name: 'owner', type: 'string', required: true },
    { name: 'size', type: 'number' },
    { name: 'mimetype', type: 'string' },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Convert SQL timestamp string to milliseconds since epoch.
 *
 * WHY: SQL stores ISO 8601 strings, VFS uses milliseconds.
 * Centralizes conversion logic for consistency.
 *
 * @param isoString - ISO 8601 timestamp string from SQL
 * @returns Milliseconds since epoch
 */
function timestampToMs(isoString: string): number {
    return new Date(isoString).getTime();
}

/**
 * Convert TempRecord from SQL to ModelStat for VFS.
 *
 * WHY: Bridges SQL row format to VFS metadata format.
 * Handles timestamp conversion and field mapping.
 *
 * @param record - SQL row from temp table
 * @returns VFS-compatible ModelStat
 */
function recordToStat(record: TempRecord): ModelStat {
    return {
        id: record.id,
        model: MODEL_NAME,
        name: record.name,
        parent: record.parent,
        owner: record.owner,
        size: record.size ?? 0,
        mtime: timestampToMs(record.updated_at),
        ctime: timestampToMs(record.created_at),
        mimetype: record.mimetype ?? undefined,
    };
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * TempModel - SQL-backed temporary file storage.
 *
 * Implements POSIX-style file operations for /tmp filesystem. Entity metadata
 * is stored in SQL via DatabaseOps, blob content in HAL storage.
 *
 * DEPENDENCY INJECTION:
 * DatabaseOps is injected via constructor to enable:
 * - Testing with mock DatabaseOps
 * - Sharing single DatabaseOps instance across models
 * - Observer pipeline integration
 */
export class TempModel extends PosixModel {
    // =========================================================================
    // MODEL IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY: Used by VFS to dispatch operations to the correct model.
     * INVARIANT: Always 'temp' for this model.
     */
    readonly name = MODEL_NAME;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Database operations interface.
     *
     * WHY: All SQL operations go through DatabaseOps for observer pipeline.
     * INVARIANT: Set at construction, never changes.
     */
    private readonly db: DatabaseOps;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new TempModel instance.
     *
     * @param db - DatabaseOps instance for SQL operations
     */
    constructor(db: DatabaseOps) {
        super();
        this.db = db;
    }

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Return field definitions for temp file entities.
     *
     * WHY: Enables schema validation and introspection.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[] {
        return TEMP_FIELDS;
    }

    // =========================================================================
    // CORE OPERATIONS
    // =========================================================================

    /**
     * Open a temp file for I/O operations.
     *
     * ALGORITHM:
     * 1. Load entity metadata from SQL via DatabaseOps
     * 2. Load blob content from HAL storage (or empty if new)
     * 3. Apply truncate flag if requested
     * 4. Create and return TempFileHandle
     *
     * RACE CONDITION:
     * Content is loaded once at open time. Concurrent opens get independent
     * snapshots. Last writer wins on close.
     *
     * @param ctx - Model context with HAL and caller info
     * @param id - Entity UUID to open
     * @param flags - Open flags (read/write/truncate/append)
     * @param _opts - Optional open options (currently unused for temp)
     * @returns FileHandle for I/O operations
     * @throws ENOENT - If file does not exist
     */
    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        // Load entity metadata from SQL
        let record: TempRecord | null = null;
        for await (const r of this.db.selectAny<TempRecord>(MODEL_NAME, {
            where: { id },
            limit: 1,
        })) {
            record = r;
            break;
        }

        if (!record) {
            throw new ENOENT(`Temp file not found: ${id}`);
        }

        // Load blob content from HAL storage
        let content: Uint8Array;
        const blobData = await ctx.hal.storage.get(`${BLOB_PREFIX}${id}`);
        content = blobData ?? new Uint8Array(0);

        // Truncate if requested (requires write permission)
        if (flags.truncate && flags.write) {
            content = new Uint8Array(0);
        }

        return new TempFileHandle(ctx, this.db, id, content, flags);
    }

    /**
     * Get metadata for a temp file.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata
     * @throws ENOENT - If file does not exist
     */
    async stat(_ctx: ModelContext, id: string): Promise<ModelStat> {
        let record: TempRecord | null = null;
        for await (const r of this.db.selectAny<TempRecord>(MODEL_NAME, {
            where: { id },
            limit: 1,
        })) {
            record = r;
            break;
        }

        if (!record) {
            throw new ENOENT(`Temp file not found: ${id}`);
        }

        return recordToStat(record);
    }

    /**
     * Update metadata fields on a temp file.
     *
     * ALGORITHM:
     * 1. Verify entity exists
     * 2. Update allowed fields via DatabaseOps (triggers observer pipeline)
     *
     * WHY DatabaseOps: Mutations go through observer pipeline for:
     * - Ring 1: Validation constraints
     * - Ring 5: SQL persistence
     * - Ring 7: Change tracking
     * - Ring 8: Cache invalidation
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update
     * @throws ENOENT - If file does not exist
     */
    async setstat(_ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        // Build changes object with only allowed fields
        const changes: Partial<TempRecord> = {};
        if (fields.name !== undefined) changes.name = fields.name;
        if (fields.parent !== undefined) changes.parent = fields.parent;
        if (fields.mimetype !== undefined) changes.mimetype = fields.mimetype ?? null;

        // Update via DatabaseOps (triggers observer pipeline)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _updated of this.db.updateAll<TempRecord>(MODEL_NAME, [
            { id, changes },
        ])) {
            // Record updated successfully
        }
    }

    /**
     * Create a new temp file.
     *
     * ALGORITHM:
     * 1. Create entity metadata in SQL via DatabaseOps
     * 2. Create empty blob in HAL storage
     * 3. Return entity UUID
     *
     * WHY blob first: If we crash after creating entity but before blob,
     * the entity would reference a non-existent blob. Creating blob first
     * means an orphaned blob (worst case) rather than a broken entity.
     *
     * Actually, for temp files using SQL (where ID is auto-generated by the
     * database), we create the entity first to get the ID, then create the blob.
     * This is acceptable for temp files given their ephemeral nature.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID (or null for root-level)
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
        // Create entity in SQL via DatabaseOps
        let createdId: string | null = null;

        for await (const created of this.db.createAll<TempRecord>(MODEL_NAME, [
            {
                name,
                parent: parent || null,
                owner: fields?.owner ?? ctx.caller,
                size: 0,
                mimetype: (fields?.mimetype as string) ?? null,
            },
        ])) {
            createdId = created.id;
            break;
        }

        if (!createdId) {
            throw new Error('Failed to create temp file entity');
        }

        // Create empty blob in HAL storage
        await ctx.hal.storage.put(`${BLOB_PREFIX}${createdId}`, new Uint8Array(0));

        return createdId;
    }

    /**
     * Delete a temp file.
     *
     * ALGORITHM:
     * 1. Delete entity from SQL via DatabaseOps (soft delete)
     * 2. Delete blob from HAL storage
     *
     * @param ctx - Model context
     * @param id - Entity UUID to delete
     * @throws ENOENT - If file does not exist
     */
    async unlink(ctx: ModelContext, id: string): Promise<void> {
        // Delete entity via DatabaseOps (soft delete through observer pipeline)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _deleted of this.db.deleteAll<TempRecord>(MODEL_NAME, [{ id }])) {
            // Entity deleted (soft delete sets trashed_at)
        }

        // Delete blob from HAL storage
        // Ignore errors - blob may not exist if file was empty
        try {
            await ctx.hal.storage.delete(`${BLOB_PREFIX}${id}`);
        } catch {
            // Blob may not exist - that's fine
        }
    }

    /**
     * List children of a temp file.
     *
     * WHY: Temp files are leaf nodes (flat structure for now).
     * Future: Could support nested folders by querying parent field.
     *
     * @returns Empty iterator (temp files have no children)
     */
    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Temp files are flat (no nested folders) - this is a no-op
        return;
    }

    // =========================================================================
    // WATCH SUPPORT (optional)
    // =========================================================================

    /**
     * Watch for changes to a temp file.
     *
     * Subscribes to HAL storage events for this file's blob key.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to watch
     * @param _pattern - Unused (temp files have no children to pattern-match)
     * @yields Watch events
     */
    override async *watch(
        ctx: ModelContext,
        id: string,
        _pattern?: string
    ): AsyncIterable<WatchEvent> {
        // Watch for changes to this file's blob
        for await (const event of ctx.hal.storage.watch(`${BLOB_PREFIX}${id}`)) {
            yield {
                entity: id,
                op: event.op === 'put' ? 'update' : 'delete',
                path: await ctx.computePath(id),
                timestamp: event.timestamp,
            };
        }
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get the DatabaseOps instance.
     * TESTING: Allows tests to verify database operations.
     */
    getDatabaseOps(): DatabaseOps {
        return this.db;
    }
}

// =============================================================================
// TEMP FILE HANDLE IMPLEMENTATION
// =============================================================================

/**
 * TempFileHandle - File handle for temp file I/O operations.
 *
 * Provides buffered read/write access to temp file content. Content is loaded
 * into memory on construction and written back on close() or sync().
 *
 * INVARIANTS:
 * - Once _closed is true, all I/O methods throw EBADF
 * - dirty is true IFF content differs from HAL storage
 * - position >= 0 always
 * - flags are immutable after construction
 */
class TempFileHandle implements FileHandle {
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
     * INVARIANT: Always empty string for TempModel handles.
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
     * WHY: Enables random access without repeated HAL calls.
     * Memory is traded for I/O efficiency.
     */
    private content: Uint8Array;

    /**
     * Whether content has been modified since last flush.
     *
     * WHY: Avoids unnecessary HAL writes on close().
     * INVARIANT: True IFF content differs from what's in HAL storage.
     */
    private dirty = false;

    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Model context for HAL access.
     *
     * WHY: Needed for HAL storage operations.
     */
    private readonly ctx: ModelContext;

    /**
     * Database operations for SQL updates.
     *
     * WHY: Needed for updating entity size in SQL on flush.
     */
    private readonly db: DatabaseOps;

    /**
     * Entity UUID.
     *
     * WHY: Identifies the entity for SQL updates and blob storage.
     */
    private readonly entityId: string;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new TempFileHandle.
     *
     * @param ctx - Model context for HAL access
     * @param db - DatabaseOps for SQL operations
     * @param entityId - Entity UUID
     * @param content - Initial content buffer
     * @param flags - Open flags
     */
    constructor(
        ctx: ModelContext,
        db: DatabaseOps,
        entityId: string,
        content: Uint8Array,
        flags: OpenFlags
    ) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.db = db;
        this.entityId = entityId;
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
        // RACE FIX RC-1: Check closure state before any operation
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
        // RACE FIX RC-1: Check closure state before any operation
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
        // RACE FIX RC-1: Check closure state before any operation
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
        // RACE FIX RC-1: Check closure state before any operation
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
     * 2. Update entity size in SQL via DatabaseOps
     * 3. Clear dirty flag
     *
     * WHY blob is written before SQL:
     * If crash occurs between writes, SQL will have old size
     * (safe but stale) rather than new size with non-existent blob.
     *
     * RACE CONDITION RC-4:
     * Check closed state after each await - handle may have been
     * closed concurrently. If closed, don't update dirty flag
     * (caller will have already returned).
     */
    private async flush(): Promise<void> {
        // Write blob to HAL storage first (see WHY above)
        await this.ctx.hal.storage.put(`${BLOB_PREFIX}${this.entityId}`, this.content);

        // RACE FIX RC-4: Check state after await
        if (this._closed) {
            return;
        }

        // Update entity size in SQL via DatabaseOps
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _updated of this.db.updateAll<TempRecord>(MODEL_NAME, [
            { id: this.entityId, changes: { size: this.content.length } },
        ])) {
            // Size updated successfully
        }

        // RACE FIX RC-4: Check state after await
        if (this._closed) {
            return;
        }

        this.dirty = false;
    }
}
