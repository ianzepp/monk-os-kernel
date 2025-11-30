/**
 * FolderModel
 *
 * Organizational container for files and other folders.
 * Folders have no data blob - children are derived via query.
 */

import type { Model, ModelStat, ModelContext, FieldDef, WatchEvent } from '@src/lib/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/lib/vfs/handle.js';
import { EISDIR, ENOENT, ENOTEMPTY } from '@src/lib/hal/index.js';

/**
 * Storage keys:
 * - entity:{uuid} → folder metadata JSON
 */

const FOLDER_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string' },
    { name: 'owner', type: 'string', required: true },
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
];

export class FolderModel implements Model {
    readonly name = 'folder';

    fields(): FieldDef[] {
        return FOLDER_FIELDS;
    }

    async open(
        _ctx: ModelContext,
        _id: string,
        _flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        // Folders cannot be opened for read/write
        throw new EISDIR('Cannot open folder for I/O');
    }

    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Folder not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data));
        return {
            ...entity,
            size: 0, // Folders have no size
        };
    }

    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Folder not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data));

        // Update allowed fields
        if (fields.name !== undefined) entity.name = fields.name;
        if (fields.parent !== undefined) entity.parent = fields.parent;
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
        const now = ctx.hal.clock.now();

        const entity: ModelStat = {
            id,
            model: 'folder',
            name,
            parent,
            owner: fields?.owner ?? ctx.caller,
            size: 0,
            mtime: now,
            ctime: now,
        };

        await ctx.hal.storage.put(
            `entity:${id}`,
            new TextEncoder().encode(JSON.stringify(entity))
        );

        return id;
    }

    async unlink(ctx: ModelContext, id: string): Promise<void> {
        // Check if folder is empty
        let hasChildren = false;
        for await (const _child of this.list(ctx, id)) {
            hasChildren = true;
            break;
        }

        if (hasChildren) {
            throw new ENOTEMPTY(`Folder not empty: ${id}`);
        }

        await ctx.hal.storage.delete(`entity:${id}`);
    }

    async *list(ctx: ModelContext, id: string): AsyncIterable<string> {
        // Find all entities with parent = id
        const prefix = 'entity:';
        for await (const key of ctx.hal.storage.list(prefix)) {
            const data = await ctx.hal.storage.get(key);
            if (!data) continue;

            const entity = JSON.parse(new TextDecoder().decode(data));
            if (entity.parent === id) {
                yield entity.id;
            }
        }
    }

    async *watch(ctx: ModelContext, id: string, pattern?: string): AsyncIterable<WatchEvent> {
        // Watch for changes to children of this folder
        const watchPattern = pattern ?? `entity:*`;

        for await (const event of ctx.hal.storage.watch(watchPattern)) {
            if (event.op === 'delete') {
                // Can't check parent of deleted entity
                yield {
                    entity: event.key.replace('entity:', ''),
                    op: 'delete',
                    path: '', // Path unknown for deleted
                    timestamp: event.timestamp,
                };
                continue;
            }

            if (!event.value) continue;

            const entity = JSON.parse(new TextDecoder().decode(event.value));
            if (entity.parent === id) {
                yield {
                    entity: entity.id,
                    op: event.op === 'put' ? (entity.ctime === entity.mtime ? 'create' : 'update') : 'delete',
                    path: await ctx.computePath(entity.id),
                    timestamp: event.timestamp,
                };
            }
        }
    }
}
