/**
 * DeviceModel
 *
 * Virtual device files under /dev/*.
 * Provides file-like interface to HAL devices.
 *
 * Standard devices:
 * - /dev/null      - Discards all writes, reads return EOF
 * - /dev/zero      - Reads return zeros, writes discarded
 * - /dev/random    - Reads return random bytes (blocking)
 * - /dev/urandom   - Reads return random bytes (non-blocking)
 * - /dev/console   - System console I/O
 * - /dev/clock     - Read returns current timestamp
 */

import { PosixModel } from '@src/vfs/model.js';
import type { ModelStat, ModelContext, FieldDef } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/vfs/handle.js';
import { ENOENT, EBADF, EACCES, EINVAL, ENOTSUP } from '@src/hal/index.js';

const DEVICE_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'device', type: 'string', required: true }, // Device type: null, zero, random, etc.
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
];

/**
 * Device types and their behavior
 */
type DeviceType = 'null' | 'zero' | 'random' | 'urandom' | 'console' | 'clock';

export class DeviceModel extends PosixModel {
    readonly name = 'device';

    fields(): FieldDef[] {
        return DEVICE_FIELDS;
    }

    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data)) as ModelStat & { device: DeviceType };
        return new DeviceHandle(ctx, id, entity.device, flags);
    }

    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data));
        return {
            ...entity,
            size: 0, // Devices have no size
        };
    }

    async setstat(ctx: ModelContext, id: string, fields: Partial<ModelStat>): Promise<void> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data));

        // Only allow updating name/parent
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
        fields?: Partial<ModelStat> & { device?: DeviceType }
    ): Promise<string> {
        const id = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();

        const entity = {
            id,
            model: 'device',
            name,
            parent,
            owner: fields?.owner ?? ctx.caller,
            device: fields?.device ?? 'null',
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
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Device not found: ${id}`);
        }

        await ctx.hal.storage.delete(`entity:${id}`);
    }

    async *list(_ctx: ModelContext, _id: string): AsyncIterable<string> {
        // Devices don't have children
        return;
    }
}

/**
 * Device handle implementation
 */
class DeviceHandle implements FileHandle {
    readonly id: string;
    readonly path: string = '';
    readonly flags: OpenFlags;

    private _closed = false;
    private ctx: ModelContext;
    private device: DeviceType;
    private consoleBuffer: Uint8Array = new Uint8Array(0);

    constructor(ctx: ModelContext, _entityId: string, device: DeviceType, flags: OpenFlags) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.device = device;
        this.flags = flags;
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

        const readSize = size ?? 4096;

        switch (this.device) {
            case 'null':
                // Always returns EOF
                return new Uint8Array(0);

            case 'zero':
                // Returns zeros
                return new Uint8Array(readSize);

            case 'random':
            case 'urandom':
                // Returns random bytes
                return this.ctx.hal.entropy.read(Math.min(readSize, 65536));

            case 'console': {
                // Read from stdin with buffering to respect size
                // First check buffer, then read more if needed
                if (this.consoleBuffer.length === 0) {
                    const chunk = await this.ctx.hal.console.read();
                    if (chunk.length === 0) {
                        return new Uint8Array(0); // EOF
                    }
                    this.consoleBuffer = chunk;
                }
                // Return requested size from buffer
                const toReturn = this.consoleBuffer.slice(0, readSize);
                this.consoleBuffer = this.consoleBuffer.slice(toReturn.length);
                return toReturn;
            }

            case 'clock':
                // Returns current timestamp as string
                const now = this.ctx.hal.clock.now();
                return new TextEncoder().encode(now.toString() + '\n');

            default:
                throw new EINVAL(`Unknown device type: ${this.device}`);
        }
    }

    async write(data: Uint8Array): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle closed');
        }
        if (!this.flags.write) {
            throw new EACCES('Handle not opened for writing');
        }

        switch (this.device) {
            case 'null':
            case 'zero':
                // Discard all writes
                return data.length;

            case 'random':
            case 'urandom':
                // Can't write to random
                throw new EACCES('Cannot write to random device');

            case 'console':
                // Write to stdout
                this.ctx.hal.console.write(data);
                return data.length;

            case 'clock':
                // Can't write to clock
                throw new EACCES('Cannot write to clock device');

            default:
                throw new EINVAL(`Unknown device type: ${this.device}`);
        }
    }

    async seek(_offset: number, _whence: SeekWhence): Promise<number> {
        // Devices are not seekable
        throw new ENOTSUP('Device is not seekable');
    }

    async tell(): Promise<number> {
        return 0;
    }

    async sync(): Promise<void> {
        // No-op for devices
    }

    async close(): Promise<void> {
        this._closed = true;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

/**
 * Initialize standard devices under /dev
 */
export async function initStandardDevices(ctx: ModelContext, devFolderId: string): Promise<void> {
    const deviceModel = new DeviceModel();
    const devices: Array<{ name: string; device: DeviceType }> = [
        { name: 'null', device: 'null' },
        { name: 'zero', device: 'zero' },
        { name: 'random', device: 'random' },
        { name: 'urandom', device: 'urandom' },
        { name: 'console', device: 'console' },
        { name: 'clock', device: 'clock' },
    ];

    for (const { name, device } of devices) {
        await deviceModel.create(ctx, devFolderId, name, {
            owner: ctx.caller,
            device,
        } as any);
    }
}
