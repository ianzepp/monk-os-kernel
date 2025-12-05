/**
 * Model - Polymorphic file behavior abstraction
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * In Monk OS, everything is a file - but files behave differently depending on
 * what they represent. A Model defines the behavior for a class of files:
 *
 * - FileModel: Traditional files with content stored in blobs
 * - FolderModel: Directories that contain other entities
 * - DeviceModel: Hardware devices (stdin, stdout, random, etc.)
 * - NetworkModel: Network sockets and connections
 * - ProcModel: Process introspection (/proc filesystem)
 *
 * Each model implements the Model interface, providing:
 * - Schema: What metadata fields exist (FieldDef[])
 * - I/O: How reads and writes work (open/read/write/close)
 * - Lifecycle: How entities are created and destroyed
 *
 * TWO PARADIGMS
 * =============
 * Models can be implemented in two ways:
 *
 * 1. MessageModel: Native message-based interface for streaming and events.
 *    The handle() method receives messages and yields responses. This is
 *    powerful but requires more implementation effort.
 *
 * 2. PosixModel: POSIX-style open/read/write/close interface. Extend this
 *    abstract class and implement the familiar file operations. The base
 *    class provides a handle() adapter that dispatches messages to POSIX
 *    methods automatically.
 *
 * OPERATION DISPATCH (PosixModel)
 * ===============================
 *
 *   Message ─────────> handle() ─────────> POSIX method
 *     │                   │                    │
 *     ├── op: 'open'  ────┼──────> open()     │
 *     ├── op: 'stat'  ────┼──────> stat()     │
 *     ├── op: 'create' ───┼──────> create()   │
 *     ├── op: 'delete' ───┼──────> unlink()   │
 *     ├── op: 'list'  ────┼──────> list()     │
 *     └── op: 'watch' ────┼──────> watch()    │
 *                         │                    │
 *                         └──> yield Response  │
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Model.name is unique across all registered models
 * INV-2: fields() returns consistent schema (same across calls)
 * INV-3: stat() returns valid ModelStat with required fields populated
 * INV-4: create() returns the UUID of the newly created entity
 * INV-5: unlink() removes the entity or throws if not possible
 * INV-6: list() only returns IDs of direct children
 *
 * CONCURRENCY MODEL
 * =================
 * Models are stateless - all state is in storage. Multiple concurrent
 * operations on the same entity are safe at the model level (storage
 * provides atomicity). FileHandle instances are independent.
 *
 * MEMORY MANAGEMENT
 * =================
 * - Models are singletons (one instance per model type)
 * - No per-entity state in model objects
 * - list() yields lazily via async iterator
 * - watch() yields events as they arrive (no buffering)
 *
 * @module vfs/model
 */

import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { HAL } from '@src/hal/index.js';
import type { Message, Response } from '@src/vfs/message.js';
import { respond } from '@src/vfs/message.js';

// =============================================================================
// SCHEMA TYPES
// =============================================================================

/**
 * Field definition for model schema.
 *
 * Describes a single field that can appear in ModelStat. Used for:
 * - Schema validation at create/update time
 * - Introspection by tools and UIs
 * - Query planning in future query systems
 *
 * WHY explicit schema: Enables type-safe operations and validation.
 * Unlike schemaless stores, we can catch errors early.
 */
export interface FieldDef {
    /**
     * Field name (key in ModelStat).
     *
     * CONVENTION: Use camelCase for consistency with TypeScript.
     */
    name: string;

    /**
     * Field type for validation.
     *
     * WHY limited types: Matches JSON serializable types.
     * Complex types should be serialized (e.g., JSON in string field).
     */
    type: 'string' | 'number' | 'boolean' | 'string[]';

    /**
     * Whether field must be present.
     *
     * WHY optional: Most fields have defaults or are computed.
     * Only truly required fields (id, name) should be required: true.
     */
    required?: boolean;

    /**
     * Allowed values for enum fields.
     *
     * WHY: Enables validation of constrained string fields.
     * Example: { name: 'state', type: 'string', enum: ['pending', 'running'] }
     */
    enum?: string[];
}

// =============================================================================
// ENTITY METADATA
// =============================================================================

/**
 * Entity metadata returned by stat().
 *
 * This is the standard metadata structure for all entities in the VFS.
 * Models may add additional fields beyond the standard ones.
 *
 * DESIGN DECISIONS:
 * - UUIDs for identity (not paths) - enables rename without breaking refs
 * - Timestamps in ms since epoch - consistent with JavaScript Date
 * - Index signature for model-specific fields
 */
export interface ModelStat {
    // -------------------------------------------------------------------------
    // Core Identity
    // -------------------------------------------------------------------------

    /**
     * Entity UUID.
     *
     * WHY UUID: Immutable identity. Paths can change (rename), UUIDs don't.
     * Enables hard links, move operations, and stable references.
     *
     * INVARIANT: Set at creation, never changes.
     */
    id: string;

    /**
     * Model type name.
     *
     * WHY: Determines which model handles this entity.
     * Allows polymorphic dispatch based on entity type.
     *
     * INVARIANT: Set at creation, never changes.
     */
    model: string;

    /**
     * Entity name (filename, not full path).
     *
     * WHY not full path: Paths are computed from parent chain.
     * Storing name only enables efficient rename (just update name field).
     */
    name: string;

    /**
     * Parent folder UUID (null for root).
     *
     * WHY parent pointer: Enables efficient move (update one field).
     * Child list would require updating many entities on move.
     *
     * INVARIANT: Root has parent = null.
     */
    parent: string | null;

    // -------------------------------------------------------------------------
    // Ownership
    // -------------------------------------------------------------------------

    /**
     * Owner UUID (process or user that created entity).
     *
     * WHY UUID: Stable reference. Users/processes are also entities.
     * Ownership determines default permissions.
     */
    owner: string;

    // -------------------------------------------------------------------------
    // Content Metadata
    // -------------------------------------------------------------------------

    /**
     * Size in bytes.
     *
     * WHY: Standard file metadata. For folders, typically 0.
     * For files, reflects actual content size.
     *
     * INVARIANT: Updated on write operations.
     */
    size: number;

    /**
     * Last modification time (ms since epoch).
     *
     * WHY ms: Matches JavaScript Date.now() precision.
     * Updated on content or metadata changes.
     */
    mtime: number;

    /**
     * Creation time (ms since epoch).
     *
     * INVARIANT: Set at creation, never changes.
     */
    ctime: number;

    /**
     * Content MIME type (optional).
     *
     * WHY optional: Not all entities have content types.
     * When present, helps with content handling decisions.
     */
    mimetype?: string;

    // -------------------------------------------------------------------------
    // Storage References
    // -------------------------------------------------------------------------

    /**
     * Data blob UUID (for file models).
     *
     * WHY separate: Allows metadata updates without touching content.
     * Enables future content deduplication.
     */
    data?: string;

    // -------------------------------------------------------------------------
    // Versioning
    // -------------------------------------------------------------------------

    /**
     * Whether version history is enabled.
     *
     * WHY opt-in: Versioning has storage overhead.
     * Only enabled when explicitly requested.
     */
    versioned?: boolean;

    /**
     * Current version number (if versioned).
     *
     * INVARIANT: Increments on each versioned write.
     */
    version?: number;

    // -------------------------------------------------------------------------
    // Extension Fields
    // -------------------------------------------------------------------------

    /**
     * Model-specific additional fields.
     *
     * WHY index signature: Models can add custom fields.
     * Example: DeviceModel adds 'deviceType', ProcModel adds 'pid'.
     */
    [key: string]: unknown;
}

// =============================================================================
// WATCH EVENTS
// =============================================================================

/**
 * Watch event emitted on entity changes.
 *
 * Subscribers to watch() receive these events when entities change.
 * Used for file system notifications and reactive updates.
 */
export interface WatchEvent {
    /**
     * Entity UUID that changed.
     *
     * WHY UUID not path: Paths can change; UUID is stable.
     */
    entity: string;

    /**
     * Type of change.
     *
     * - 'create': New entity created
     * - 'update': Entity metadata or content changed
     * - 'delete': Entity removed
     */
    op: 'create' | 'update' | 'delete';

    /**
     * Path of entity at time of change.
     *
     * WHY included: Convenience for subscribers.
     * May be stale if rename happens after event generation.
     */
    path: string;

    /**
     * Fields that changed (for 'update' events).
     *
     * WHY optional: Not all storage engines track field-level changes.
     * When present, enables efficient partial updates.
     */
    fields?: string[];

    /**
     * Timestamp of change (ms since epoch).
     *
     * WHY: Ordering and deduplication of events.
     */
    timestamp: number;
}

// =============================================================================
// MODEL CONTEXT
// =============================================================================

/**
 * Context passed to model operations.
 *
 * Provides access to HAL services and VFS utilities without requiring
 * models to maintain references to the full VFS.
 *
 * WHY separate from VFS: Models shouldn't have full VFS access.
 * Context provides exactly what's needed, nothing more (least privilege).
 */
export interface ModelContext {
    /**
     * Hardware Abstraction Layer.
     *
     * Provides access to storage, clock, entropy, and other HAL services.
     * Models use this for all I/O operations.
     */
    hal: HAL;

    /**
     * Caller's UUID (process or user making the request).
     *
     * WHY: Enables ownership assignment and permission checks.
     * Set by kernel based on authenticated caller.
     */
    caller: string;

    /**
     * Resolve path to entity UUID.
     *
     * WHY in context: Models may need to resolve paths (e.g., symlinks).
     * Provided by VFS, not implemented by models.
     *
     * @param path - Absolute path to resolve
     * @returns Entity UUID or null if not found
     */
    resolve(path: string): Promise<string | null>;

    /**
     * Get entity by UUID.
     *
     * WHY in context: Models may need to access related entities.
     * Provided by VFS, not implemented by models.
     *
     * @param id - Entity UUID
     * @returns Entity metadata or null if not found
     */
    getEntity(id: string): Promise<ModelStat | null>;

    /**
     * Compute full path for entity.
     *
     * WHY: Paths are computed from parent chain.
     * Needed for watch events and error messages.
     *
     * @param id - Entity UUID
     * @returns Full absolute path
     */
    computePath(id: string): Promise<string>;
}

// =============================================================================
// MODEL INTERFACE
// =============================================================================

/**
 * Model interface.
 *
 * Each model type (file, folder, device, etc.) implements this interface
 * to define behavior for a class of entities. The VFS dispatches operations
 * to the appropriate model based on entity type.
 *
 * EXTENSION POINTS:
 * - watch: Optional method for change notifications
 * - handle: Optional method for native message handling
 */
export interface Model {
    // =========================================================================
    // IDENTITY
    // =========================================================================

    /**
     * Model identifier.
     *
     * WHY readonly: Model name is immutable identity.
     * Used for dispatch and stored in entity.model field.
     *
     * INVARIANT: Unique across all registered models.
     */
    readonly name: string;

    // =========================================================================
    // SCHEMA
    // =========================================================================

    /**
     * Schema definition for stat() fields.
     *
     * WHY method not property: Allows lazy computation if needed.
     * Most implementations return a constant array.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[];

    // =========================================================================
    // HANDLE OPERATIONS
    // =========================================================================

    /**
     * Open entity for I/O, returning a handle.
     *
     * ALGORITHM (typical):
     * 1. Validate entity exists
     * 2. Check permissions (via ACL)
     * 3. Load content if needed
     * 4. Create and return FileHandle
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param flags - Open flags (read/write/create/etc.)
     * @param opts - Additional options
     * @returns FileHandle for I/O operations
     * @throws ENOENT - If entity doesn't exist
     * @throws EACCES - If permission denied
     * @throws EISDIR - If entity is directory (for file models)
     */
    open(ctx: ModelContext, id: string, flags: OpenFlags, opts?: OpenOptions): Promise<FileHandle>;

    // =========================================================================
    // METADATA OPERATIONS
    // =========================================================================

    /**
     * Get metadata for an entity.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata
     * @throws ENOENT - If entity doesn't exist
     */
    stat(ctx: ModelContext, id: string): Promise<ModelStat>;

    /**
     * Update metadata fields.
     *
     * Only allowed fields are updated (model-dependent).
     * Immutable fields (id, model, ctime) are ignored.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update
     * @throws ENOENT - If entity doesn't exist
     * @throws EACCES - If permission denied
     */
    setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void>;

    // =========================================================================
    // LIFECYCLE OPERATIONS
    // =========================================================================

    /**
     * Create a new entity.
     *
     * ALGORITHM (typical):
     * 1. Generate UUID for new entity
     * 2. Initialize metadata with defaults
     * 3. Create storage entries
     * 4. Return new entity UUID
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param name - Entity name
     * @param fields - Initial field values
     * @returns Created entity UUID
     * @throws EEXIST - If entity with same name exists
     * @throws EACCES - If permission denied
     */
    create(ctx: ModelContext, parent: string, name: string, fields?: Partial<ModelStat>): Promise<string>;

    /**
     * Remove an entity.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @throws ENOENT - If entity doesn't exist
     * @throws ENOTEMPTY - If directory not empty
     * @throws EACCES - If permission denied
     */
    unlink(ctx: ModelContext, id: string): Promise<void>;

    // =========================================================================
    // ENUMERATION
    // =========================================================================

    /**
     * List children (for directory-like models).
     *
     * WHY async iterator: Streaming avoids loading all children into memory.
     * For leaf entities (files), yields nothing.
     *
     * @param ctx - Model context
     * @param id - Parent entity UUID
     * @yields Child entity UUIDs
     */
    list(ctx: ModelContext, id: string): AsyncIterable<string>;

    // =========================================================================
    // OPTIONAL METHODS
    // =========================================================================

    /**
     * Watch for changes to entity or its children.
     *
     * WHY optional: Not all models support change notifications.
     * When implemented, yields events as changes occur.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to watch
     * @param pattern - Optional glob pattern for filtering children
     * @yields Watch events
     */
    watch?(ctx: ModelContext, id: string, pattern?: string): AsyncIterable<WatchEvent>;

    /**
     * Handle a message (native message-based interface).
     *
     * WHY optional: Most models extend PosixModel which provides this.
     * Implement directly for custom streaming or event behavior.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param msg - Message to handle
     * @yields Response messages
     */
    handle?(ctx: ModelContext, id: string, msg: Message): AsyncIterable<Response>;
}

// =============================================================================
// MESSAGE MODEL INTERFACE
// =============================================================================

/**
 * MessageModel interface.
 *
 * Native message-based model for streaming and events. Implement this
 * directly when you need full control over message handling.
 *
 * WHEN TO USE:
 * - Streaming large files
 * - Real-time event sources
 * - Bidirectional communication (websockets)
 * - Custom protocols
 *
 * Most models should extend PosixModel instead for simpler implementation.
 */
export interface MessageModel {
    /**
     * Model identifier.
     *
     * WHY readonly: Same as Model interface.
     */
    readonly name: string;

    /**
     * Schema definition.
     *
     * WHY: Same as Model interface.
     */
    fields(): FieldDef[];

    /**
     * Handle a message.
     *
     * All operations are expressed as messages. The implementation
     * yields zero or more responses:
     * - respond.ok() for success
     * - respond.error() for failure
     * - respond.item() for list results
     * - respond.data() for binary data
     * - respond.event() for watch notifications
     * - respond.done() to end a stream
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param msg - Message to handle
     * @yields Response messages
     */
    handle(ctx: ModelContext, id: string, msg: Message): AsyncIterable<Response>;
}

// =============================================================================
// POSIX MODEL ABSTRACT CLASS
// =============================================================================

/**
 * PosixModel abstract class.
 *
 * Provides POSIX-style open/read/write/close interface with automatic
 * adaptation to the message-based handle() interface.
 *
 * USAGE:
 * 1. Extend this class
 * 2. Implement abstract methods (open, stat, setstat, create, unlink, list)
 * 3. Optionally override watch() for change notifications
 * 4. The handle() method dispatches messages to your POSIX methods
 *
 * EXAMPLE:
 * ```typescript
 * export class FileModel extends PosixModel {
 *     readonly name = 'file';
 *     fields() { return FILE_FIELDS; }
 *     async open(...) { ... }
 *     async stat(...) { ... }
 *     // etc.
 * }
 * ```
 */
export abstract class PosixModel implements Model {
    // =========================================================================
    // ABSTRACT MEMBERS
    // =========================================================================

    /** Model identifier. Must be overridden by subclass. */
    abstract readonly name: string;

    /** Schema definition. Must be overridden by subclass. */
    abstract fields(): FieldDef[];

    /** Open entity for I/O. Must be overridden by subclass. */
    abstract open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        opts?: OpenOptions
    ): Promise<FileHandle>;

    /** Get entity metadata. Must be overridden by subclass. */
    abstract stat(ctx: ModelContext, id: string): Promise<ModelStat>;

    /** Update entity metadata. Must be overridden by subclass. */
    abstract setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void>;

    /** Create new entity. Must be overridden by subclass. */
    abstract create(
        ctx: ModelContext,
        parent: string,
        name: string,
        fields?: Partial<ModelStat>
    ): Promise<string>;

    /** Delete entity. Must be overridden by subclass. */
    abstract unlink(ctx: ModelContext, id: string): Promise<void>;

    /** List children. Must be overridden by subclass. */
    abstract list(ctx: ModelContext, id: string): AsyncIterable<string>;

    // =========================================================================
    // OPTIONAL MEMBERS
    // =========================================================================

    /**
     * Watch for changes (optional).
     *
     * Override in subclass to support change notifications.
     * Default implementation not provided - calling watch on a model
     * that doesn't support it returns ENOSYS in handle().
     */
    watch?(ctx: ModelContext, id: string, pattern?: string): AsyncIterable<WatchEvent>;

    // =========================================================================
    // MESSAGE DISPATCH
    // =========================================================================

    /**
     * Handle a message by dispatching to POSIX methods.
     *
     * ALGORITHM:
     * 1. Switch on message.op
     * 2. Call appropriate POSIX method with extracted parameters
     * 3. Yield response (ok, error, item, etc.)
     * 4. Catch errors and yield error response
     *
     * ERROR HANDLING:
     * Errors thrown by POSIX methods are caught and converted to
     * respond.error() with code and message. This ensures the
     * message stream is properly terminated on error.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param msg - Message to handle
     * @yields Response messages
     */
    async *handle(ctx: ModelContext, id: string, msg: Message): AsyncIterable<Response> {
        try {
            switch (msg.op) {
                // -----------------------------------------------------------------
                // Handle Operations
                // -----------------------------------------------------------------
                case 'open': {
                    const data = msg.data as { flags: OpenFlags; opts?: OpenOptions };
                    const handle = await this.open(ctx, id, data.flags, data.opts);

                    yield respond.ok({ handle: handle.id });
                    break;
                }

                // -----------------------------------------------------------------
                // Metadata Operations
                // -----------------------------------------------------------------
                case 'stat': {
                    const stat = await this.stat(ctx, id);

                    yield respond.ok(stat);
                    break;
                }

                case 'setstat': {
                    const fields = msg.data as Partial<ModelStat>;

                    await this.setstat(ctx, id, fields);
                    yield respond.ok();
                    break;
                }

                // -----------------------------------------------------------------
                // Lifecycle Operations
                // -----------------------------------------------------------------
                case 'create': {
                    const data = msg.data as { name: string; fields?: Partial<ModelStat> };
                    const newId = await this.create(ctx, id, data.name, data.fields);

                    yield respond.ok({ id: newId });
                    break;
                }

                case 'delete': {
                    await this.unlink(ctx, id);
                    yield respond.ok();
                    break;
                }

                // -----------------------------------------------------------------
                // Enumeration
                // -----------------------------------------------------------------
                case 'list': {
                    for await (const childId of this.list(ctx, id)) {
                        // Fetch full entity for each child
                        const child = await ctx.getEntity(childId);

                        if (child) {
                            yield respond.item(child);
                        }
                    }

                    yield respond.done();
                    break;
                }

                // -----------------------------------------------------------------
                // Watch
                // -----------------------------------------------------------------
                case 'watch': {
                    if (!this.watch) {
                        yield respond.error('ENOSYS', 'Watch not supported');
                        break;
                    }

                    const data = msg.data as { pattern?: string } | undefined;

                    for await (const event of this.watch(ctx, id, data?.pattern)) {
                        yield respond.event(event.op, {
                            entity: event.entity,
                            path: event.path,
                            timestamp: event.timestamp,
                            fields: event.fields,
                        });
                    }

                    break;
                }

                // -----------------------------------------------------------------
                // Unknown Operation
                // -----------------------------------------------------------------
                default:
                    yield respond.error('ENOSYS', `Unknown operation: ${msg.op}`);
            }
        }
        catch (err) {
            // Convert thrown errors to error responses
            const error = err as Error & { code?: string };

            yield respond.error(
                error.code ?? 'EIO',
                error.message ?? 'Unknown error',
            );
        }
    }
}
