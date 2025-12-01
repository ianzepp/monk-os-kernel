/**
 * Model
 *
 * A Model defines how a class of files behaves. Every path maps to a model,
 * and the model determines:
 * - What metadata fields exist (schema)
 * - Where bytes come from on read
 * - Where bytes go on write
 * - How flow control works
 *
 * Two paradigms are supported:
 * - MessageModel: Native message-based interface (streaming, events)
 * - PosixModel: POSIX-style open/read/write/close (adapts to MessageModel)
 */

import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { ACL } from '@src/vfs/acl.js';
import type { HAL } from '@src/hal/index.js';
import type { Message, Response } from '@src/vfs/message.js';
import { respond } from '@src/vfs/message.js';

/**
 * Field definition for model schema
 */
export interface FieldDef {
    /** Field name */
    name: string;
    /** Field type */
    type: 'string' | 'number' | 'boolean' | 'string[]';
    /** True if field is required */
    required?: boolean;
    /** Allowed values for enum fields */
    enum?: string[];
}

/**
 * Entity metadata returned by stat()
 */
export interface ModelStat {
    /** Entity UUID */
    id: string;
    /** Model name */
    model: string;
    /** Entity name (filename, not full path) */
    name: string;
    /** Parent folder UUID (null for root) */
    parent: string | null;
    /** Owner UUID (process/user that created it) */
    owner: string;
    /** Size in bytes (for files) */
    size: number;
    /** Last modification time (ms since epoch) */
    mtime: number;
    /** Creation time (ms since epoch) */
    ctime: number;
    /** Content type (optional) */
    mimetype?: string;
    /** Data blob UUID (for files) */
    data?: string;
    /** True if versioning is enabled */
    versioned?: boolean;
    /** Current version number (if versioned) */
    version?: number;
    /** Additional model-specific fields */
    [key: string]: unknown;
}

/**
 * Watch event emitted on entity changes
 */
export interface WatchEvent {
    /** Entity UUID that changed */
    entity: string;
    /** Type of change */
    op: 'create' | 'update' | 'delete';
    /** Path of entity */
    path: string;
    /** Fields that changed (for update) */
    fields?: string[];
    /** Timestamp of change */
    timestamp: number;
}

/**
 * Context passed to model operations
 */
export interface ModelContext {
    /** HAL for device access */
    hal: HAL;
    /** Caller's UUID (process or user) */
    caller: string;
    /** Resolve path to entity UUID */
    resolve(path: string): Promise<string | null>;
    /** Get entity by UUID */
    getEntity(id: string): Promise<ModelStat | null>;
    /** Compute full path for entity */
    computePath(id: string): Promise<string>;
}

/**
 * Model interface.
 *
 * Each model implements this interface to define behavior
 * for a class of files.
 */
export interface Model {
    /** Model identifier (e.g., 'file', 'folder', 'network') */
    readonly name: string;

    /**
     * Schema definition for stat() fields.
     *
     * @returns Array of field definitions
     */
    fields(): FieldDef[];

    /**
     * Open a path, returning a handle for I/O.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param flags - Open flags
     * @param opts - Open options
     * @returns FileHandle for I/O
     */
    open(ctx: ModelContext, id: string, flags: OpenFlags, opts?: OpenOptions): Promise<FileHandle>;

    /**
     * Get metadata for an entity.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @returns Entity metadata
     */
    stat(ctx: ModelContext, id: string): Promise<ModelStat>;

    /**
     * Update metadata fields.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param fields - Fields to update
     */
    setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void>;

    /**
     * Create a new entity.
     *
     * @param ctx - Model context
     * @param parent - Parent folder UUID
     * @param name - Entity name
     * @param fields - Initial field values
     * @returns Created entity UUID
     */
    create(ctx: ModelContext, parent: string, name: string, fields?: Partial<ModelStat>): Promise<string>;

    /**
     * Remove an entity.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     */
    unlink(ctx: ModelContext, id: string): Promise<void>;

    /**
     * List children (for directory-like models).
     *
     * @param ctx - Model context
     * @param id - Parent entity UUID
     * @returns Child entity UUIDs
     */
    list(ctx: ModelContext, id: string): AsyncIterable<string>;

    /**
     * Watch for changes.
     *
     * @param ctx - Model context
     * @param id - Entity UUID to watch
     * @param pattern - Optional glob pattern for children
     * @returns Stream of watch events
     */
    watch?(ctx: ModelContext, id: string, pattern?: string): AsyncIterable<WatchEvent>;

    /**
     * Handle a message (native message-based interface).
     *
     * Models can implement this directly for streaming/event support,
     * or extend PosixModel to get automatic dispatch to POSIX methods.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param msg - Message to handle
     * @returns Stream of response messages
     */
    handle?(ctx: ModelContext, id: string, msg: Message): AsyncIterable<Response>;
}

/**
 * MessageModel interface.
 *
 * Native message-based model for streaming and events.
 * Implement this directly for full control over message handling.
 */
export interface MessageModel {
    /** Model identifier */
    readonly name: string;

    /** Schema definition */
    fields(): FieldDef[];

    /**
     * Handle a message.
     *
     * @param ctx - Model context
     * @param id - Entity UUID
     * @param msg - Message to handle
     * @returns Stream of response messages
     */
    handle(ctx: ModelContext, id: string, msg: Message): AsyncIterable<Response>;
}

/**
 * PosixModel abstract class.
 *
 * Provides POSIX-style open/read/write/close interface with automatic
 * adaptation to message-based handle().
 *
 * Extend this class and implement the abstract methods. The handle()
 * method dispatches to the appropriate POSIX method based on msg.op.
 */
export abstract class PosixModel implements Model {
    abstract readonly name: string;

    abstract fields(): FieldDef[];

    abstract open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        opts?: OpenOptions
    ): Promise<FileHandle>;

    abstract stat(ctx: ModelContext, id: string): Promise<ModelStat>;

    abstract setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void>;

    abstract create(
        ctx: ModelContext,
        parent: string,
        name: string,
        fields?: Partial<ModelStat>
    ): Promise<string>;

    abstract unlink(ctx: ModelContext, id: string): Promise<void>;

    abstract list(ctx: ModelContext, id: string): AsyncIterable<string>;

    watch?(ctx: ModelContext, id: string, pattern?: string): AsyncIterable<WatchEvent>;

    /**
     * Handle a message by dispatching to POSIX methods.
     */
    async *handle(ctx: ModelContext, id: string, msg: Message): AsyncIterable<Response> {
        try {
            switch (msg.op) {
                case 'open': {
                    const data = msg.data as { flags: OpenFlags; opts?: OpenOptions };
                    const handle = await this.open(ctx, id, data.flags, data.opts);
                    yield respond.ok({ handle: handle.id });
                    break;
                }

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

                case 'list': {
                    for await (const childId of this.list(ctx, id)) {
                        const child = await ctx.getEntity(childId);
                        if (child) {
                            yield respond.item(child);
                        }
                    }
                    yield respond.done();
                    break;
                }

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

                default:
                    yield respond.error('ENOSYS', `Unknown operation: ${msg.op}`);
            }
        } catch (err) {
            const error = err as Error & { code?: string };
            yield respond.error(
                error.code ?? 'EIO',
                error.message ?? 'Unknown error'
            );
        }
    }
}
