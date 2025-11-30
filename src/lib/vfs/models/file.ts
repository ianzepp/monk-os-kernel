/**
 * FileModel
 *
 * Standard file storage backed by StorageEngine.
 * Files have metadata (entity) and content (data blob).
 */

import type { Model, ModelStat, ModelContext, FieldDef, WatchEvent } from '@src/lib/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/lib/vfs/handle.js';
import { ENOENT, EBADF, EACCES, EINVAL } from '@src/lib/hal/index.js';

/**
 * Storage keys:
 * - entity:{uuid} → file metadata JSON
 * - data:{uuid}   → raw file content bytes
 * - access:{uuid} → ACL JSON (handled by VFS layer)
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

export class FileModel implements Model {
    readonly name = 'file';

    fields(): FieldDef[] {
        return FILE_FIELDS;
    }

    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        opts?: OpenOptions
    ): Promise<FileHandle> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data)) as ModelStat;

        // Load current content
        let content: Uint8Array;
        if (entity.data) {
            const blobData = await ctx.hal.storage.get(`data:${entity.data}`);
            content = blobData ?? new Uint8Array(0);
        } else {
            content = new Uint8Array(0);
        }

        // Truncate if requested
        if (flags.truncate && flags.write) {
            content = new Uint8Array(0);
        }

        return new FileHandleImpl(
            ctx,
            id,
            entity,
            content,
            flags,
            opts
        );
    }

    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        return JSON.parse(new TextDecoder().decode(data));
    }

    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data));

        // Update allowed fields
        if (fields.name !== undefined) entity.name = fields.name;
        if (fields.parent !== undefined) entity.parent = fields.parent;
        if (fields.mimetype !== undefined) entity.mimetype = fields.mimetype;
        if (fields.versioned !== undefined) entity.versioned = fields.versioned;
        entity.mtime = ctx.hal.clock.now();

        await ctx.hal.storage.put(
            `entity:${id}`,
            new TextEncoder().encode(JSON.stringify(entity))
        );
    }

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

        // Create empty data blob
        await ctx.hal.storage.put(`data:${dataId}`, new Uint8Array(0));

        // Create entity
        await ctx.hal.storage.put(
            `entity:${id}`,
            new TextEncoder().encode(JSON.stringify(entity))
        );

        return id;
    }

    async unlink(ctx: ModelContext, id: string): Promise<void> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`File not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data)) as ModelStat;

        // Delete data blob
        if (entity.data) {
            await ctx.hal.storage.delete(`data:${entity.data}`);
        }

        // Delete entity
        await ctx.hal.storage.delete(`entity:${id}`);

        // Delete ACL (if exists)
        await ctx.hal.storage.delete(`access:${id}`);
    }

    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Files don't have children
        return;
    }

    async *watch(ctx: ModelContext, id: string, _pattern?: string): AsyncIterable<WatchEvent> {
        // Watch for changes to this specific file
        for await (const event of ctx.hal.storage.watch(`entity:${id}`)) {
            yield {
                entity: id,
                op: event.op === 'put' ? 'update' : 'delete',
                path: await ctx.computePath(id),
                timestamp: event.timestamp,
            };
        }
    }
}

/**
 * FileHandle implementation for FileModel
 */
class FileHandleImpl implements FileHandle {
    readonly id: string;
    readonly path: string = '';
    readonly flags: OpenFlags;

    private _closed = false;
    private position = 0;
    private content: Uint8Array;
    private dirty = false;
    private ctx: ModelContext;
    private entityId: string;
    private entity: ModelStat;
    private opts?: OpenOptions;

    constructor(
        ctx: ModelContext,
        entityId: string,
        entity: ModelStat,
        content: Uint8Array,
        flags: OpenFlags,
        opts?: OpenOptions
    ) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.entityId = entityId;
        this.entity = entity;
        this.content = content;
        this.flags = flags;
        this.opts = opts;

        // Append mode starts at end
        if (flags.append) {
            this.position = content.length;
        }
    }

    get closed(): boolean {
        return this._closed;
    }

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

    async write(data: Uint8Array): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle closed');
        }
        if (!this.flags.write) {
            throw new EACCES('Handle not opened for writing');
        }

        // Append mode always writes at end
        if (this.flags.append) {
            this.position = this.content.length;
        }

        // Expand content if needed
        const endPos = this.position + data.length;
        if (endPos > this.content.length) {
            const newContent = new Uint8Array(endPos);
            newContent.set(this.content);
            this.content = newContent;
        }

        // Write data
        this.content.set(data, this.position);
        this.position = endPos;
        this.dirty = true;

        return data.length;
    }

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

        // Flush any pending writes
        if (this.dirty) {
            await this.flush();
        }

        this._closed = true;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private async flush(): Promise<void> {
        const now = this.ctx.hal.clock.now();

        // Update data blob
        await this.ctx.hal.storage.put(`data:${this.entity.data}`, this.content);

        // Update entity metadata
        this.entity.size = this.content.length;
        this.entity.mtime = now;

        await this.ctx.hal.storage.put(
            `entity:${this.entityId}`,
            new TextEncoder().encode(JSON.stringify(this.entity))
        );

        this.dirty = false;
    }
}
