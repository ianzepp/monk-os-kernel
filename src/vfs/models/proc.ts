/**
 * ProcModel
 *
 * Process information files under /proc/{uuid}/*.
 * Provides read-only view into process state.
 *
 * Structure per process:
 * - /proc/{uuid}/stat    - Process status (JSON)
 * - /proc/{uuid}/env     - Environment variables
 * - /proc/{uuid}/cwd     - Current working directory
 * - /proc/{uuid}/fd/     - Open file descriptors
 */

import type { Model, ModelStat, ModelContext, FieldDef } from '@src/vfs/model.js';
import type { FileHandle, OpenFlags, OpenOptions, SeekWhence } from '@src/vfs/handle.js';
import { ENOENT, EBADF, EACCES, EROFS, ENOTSUP } from '@src/hal/index.js';

const PROC_FIELDS: FieldDef[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'model', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'parent', type: 'string', required: true },
    { name: 'owner', type: 'string', required: true },
    { name: 'procType', type: 'string', required: true }, // stat, env, cwd, fd
    { name: 'processId', type: 'string', required: true }, // UUID of the process
    { name: 'mtime', type: 'number', required: true },
    { name: 'ctime', type: 'number', required: true },
];

/**
 * Process state stored in kernel
 */
export interface ProcessState {
    /** Process UUID */
    id: string;
    /** Process name */
    name: string;
    /** Parent process UUID */
    parent: string | null;
    /** Process status */
    status: 'running' | 'sleeping' | 'stopped' | 'zombie';
    /** Start time */
    startTime: number;
    /** Current working directory path */
    cwd: string;
    /** Environment variables */
    env: Record<string, string>;
    /** Open file descriptors (fd number → path) */
    fds: Record<number, string>;
}

/**
 * Registry for process state (kernel maintains this)
 */
export class ProcessRegistry {
    private processes = new Map<string, ProcessState>();

    register(state: ProcessState): void {
        this.processes.set(state.id, state);
    }

    unregister(id: string): void {
        this.processes.delete(id);
    }

    get(id: string): ProcessState | undefined {
        return this.processes.get(id);
    }

    list(): string[] {
        return Array.from(this.processes.keys());
    }

    update(id: string, updates: Partial<ProcessState>): void {
        const state = this.processes.get(id);
        if (state) {
            Object.assign(state, updates);
        }
    }
}

type ProcType = 'stat' | 'env' | 'cwd' | 'fd';

export class ProcModel implements Model {
    readonly name = 'proc';
    private registry: ProcessRegistry;

    constructor(registry: ProcessRegistry) {
        this.registry = registry;
    }

    fields(): FieldDef[] {
        return PROC_FIELDS;
    }

    async open(
        ctx: ModelContext,
        id: string,
        flags: OpenFlags,
        _opts?: OpenOptions
    ): Promise<FileHandle> {
        // Proc files are read-only
        if (flags.write) {
            throw new EROFS('Proc files are read-only');
        }

        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Proc file not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data)) as ModelStat & {
            procType: ProcType;
            processId: string;
        };

        return new ProcHandle(ctx, id, entity.procType, entity.processId, this.registry, flags);
    }

    async stat(ctx: ModelContext, id: string): Promise<ModelStat> {
        const data = await ctx.hal.storage.get(`entity:${id}`);
        if (!data) {
            throw new ENOENT(`Proc file not found: ${id}`);
        }

        const entity = JSON.parse(new TextDecoder().decode(data));
        return {
            ...entity,
            size: 0, // Size computed on read
        };
    }

    async setstat(_ctx: ModelContext, _id: string, _fields: Partial<ModelStat>): Promise<void> {
        throw new EROFS('Proc files are read-only');
    }

    async create(
        ctx: ModelContext,
        parent: string,
        name: string,
        fields?: Partial<ModelStat> & { procType?: ProcType; processId?: string }
    ): Promise<string> {
        const id = ctx.hal.entropy.uuid();
        const now = ctx.hal.clock.now();

        const entity = {
            id,
            model: 'proc',
            name,
            parent,
            owner: fields?.owner ?? ctx.caller,
            procType: fields?.procType ?? 'stat',
            processId: fields?.processId ?? '',
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
        // Allow cleanup when process exits
        await ctx.hal.storage.delete(`entity:${id}`);
    }

    async *list(ctx: ModelContext, id: string): AsyncIterable<string> {
        // List proc entries under this folder
        for await (const key of ctx.hal.storage.list('entity:')) {
            const data = await ctx.hal.storage.get(key);
            if (!data) continue;

            const entity = JSON.parse(new TextDecoder().decode(data));
            if (entity.parent === id && entity.model === 'proc') {
                yield entity.id;
            }
        }
    }
}

/**
 * Proc file handle
 */
class ProcHandle implements FileHandle {
    readonly id: string;
    readonly path: string = '';
    readonly flags: OpenFlags;

    private _closed = false;
    private ctx: ModelContext;
    private entityId: string;
    private procType: ProcType;
    private processId: string;
    private registry: ProcessRegistry;
    private content: Uint8Array | null = null;
    private position = 0;

    constructor(
        ctx: ModelContext,
        entityId: string,
        procType: ProcType,
        processId: string,
        registry: ProcessRegistry,
        flags: OpenFlags
    ) {
        this.id = ctx.hal.entropy.uuid();
        this.ctx = ctx;
        this.entityId = entityId;
        this.procType = procType;
        this.processId = processId;
        this.registry = registry;
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

        // Generate content on first read
        if (this.content === null) {
            this.content = this.generateContent();
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

    async write(_data: Uint8Array): Promise<number> {
        throw new EROFS('Proc files are read-only');
    }

    async seek(offset: number, whence: SeekWhence): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle closed');
        }

        // Generate content if needed for seeking
        if (this.content === null) {
            this.content = this.generateContent();
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
                throw new ENOTSUP(`Invalid whence: ${whence}`);
        }

        if (newPos < 0) {
            newPos = 0;
        }

        this.position = newPos;
        return this.position;
    }

    async tell(): Promise<number> {
        return this.position;
    }

    async sync(): Promise<void> {
        // No-op for proc
    }

    async close(): Promise<void> {
        this._closed = true;
        this.content = null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private generateContent(): Uint8Array {
        const process = this.registry.get(this.processId);
        if (!process) {
            return new TextEncoder().encode('(process not found)\n');
        }

        let text: string;
        switch (this.procType) {
            case 'stat':
                text = JSON.stringify(
                    {
                        id: process.id,
                        name: process.name,
                        parent: process.parent,
                        status: process.status,
                        startTime: process.startTime,
                    },
                    null,
                    2
                ) + '\n';
                break;

            case 'env':
                text = Object.entries(process.env)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n') + '\n';
                break;

            case 'cwd':
                text = process.cwd + '\n';
                break;

            case 'fd':
                text = Object.entries(process.fds)
                    .map(([fd, path]) => `${fd}\t${path}`)
                    .join('\n') + '\n';
                break;

            default:
                text = '(unknown proc type)\n';
        }

        return new TextEncoder().encode(text);
    }
}

/**
 * Create proc entries for a new process
 */
export async function createProcessProc(
    ctx: ModelContext,
    procFolderId: string,
    processState: ProcessState
): Promise<string> {
    const procModel = new ProcModel(new ProcessRegistry()); // Temp, won't be used for create

    // Create process folder: /proc/{uuid}
    const folderModel = await import('@src/vfs/models/folder.js').then((m) => new m.FolderModel());
    const processFolderId = await folderModel.create(ctx, procFolderId, processState.id, {
        owner: processState.id,
    });

    // Create proc files
    const procFiles: Array<{ name: string; procType: ProcType }> = [
        { name: 'stat', procType: 'stat' },
        { name: 'env', procType: 'env' },
        { name: 'cwd', procType: 'cwd' },
    ];

    for (const { name, procType } of procFiles) {
        await procModel.create(ctx, processFolderId, name, {
            owner: processState.id,
            procType,
            processId: processState.id,
        } as any);
    }

    // Create fd folder
    await folderModel.create(ctx, processFolderId, 'fd', {
        owner: processState.id,
    });

    return processFolderId;
}
