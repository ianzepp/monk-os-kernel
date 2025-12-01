/**
 * LinkModel
 *
 * Symbolic link model. Links store a target path and resolve
 * to that path during VFS path resolution.
 *
 * Note: Symbolic links are currently disabled. All operations
 * that would create a link will throw EPERM.
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import { ENOENT, EPERM, EINVAL } from '@src/hal/index.js';

const LINK_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'target', type: 'string', required: true },
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
];

export class LinkModel extends PosixModel {
    readonly name = 'link';

    fields(): FieldDef[] {
        return LINK_FIELDS;
    }

    /**
     * Opening a symlink should follow the target.
     * VFS handles resolution - this should not be called directly.
     */
    async open(
        _ctx: ModelContext,
        _id: string,
        _flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        throw new EINVAL('Cannot open symlink directly');
    }

    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Link not found: ${id}`);
        }
        return JSON.parse(new TextDecoder().decode(data));
    }

    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Link not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data));

        if (fields.name !== undefined) entity.name = fields.name;
        if (fields.parent !== undefined) entity.parent = fields.parent;
        if (fields.target !== undefined) entity.target = fields.target;
        entity.mtime = ctx.hal.clock.now();

        await ctx.hal.storage.put(
            `entity:${id}`,
            new TextEncoder().encode(JSON.stringify(entity))
        );
    }

    /**
     * Create a symbolic link.
     *
     * Currently disabled - throws EPERM.
     */
    async create(
        _ctx: ModelContext,
        _parent: string,
        _name: string,
        _fields?: Partial<ModelStat>
    ): Promise<string> {
        throw new EPERM('Symbolic links are not supported');
    }

    async unlink(ctx: ModelContext, id: string): Promise<void> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Link not found: ${id}`);
        }

        await ctx.hal.storage.delete(`entity:${id}`);
        await ctx.hal.storage.delete(`access:${id}`);
    }

    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Links don't have children
        return;
    }

    /**
     * Read the symlink target without following.
     */
    async readlink(ctx: ModelContext, id: string): Promise<string> {
        const stat = await this.stat(ctx, id);
        return stat.target as string;
    }
}
