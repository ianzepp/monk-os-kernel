import { describe, it, expect, beforeEach } from 'bun:test';
import { FileModel } from '@src/vfs/models/file.js';
import { FolderModel } from '@src/vfs/models/folder.js';
import type { ModelContext, ModelStat } from '@src/vfs/model.js';
import type { HAL } from '@src/hal/index.js';
import {
    MemoryStorageEngine,
    MockClockDevice,
    SeededEntropyDevice,
    MemoryBlockDevice,
    MockTimerDevice,
    BufferConsoleDevice,
    MockDNSDevice,
    MockHostDevice,
    MockIPCDevice,
    BunCryptoDevice,
    BunChannelDevice,
    ENOENT,
    EISDIR,
    ENOTEMPTY,
} from '@src/hal/index.js';
import { createMockDatabaseOps, createMockEntityCache } from '../helpers/test-mocks.js';
import type { EntityCache } from '@src/model/entity-cache.js';

function createMockHAL(): HAL {
    const storage = new MemoryStorageEngine();
    const clock = new MockClockDevice();
    const entropy = new SeededEntropyDevice(12345);
    const timer = new MockTimerDevice();

    clock.set(1000000);

    return {
        block: new MemoryBlockDevice(),
        storage,
        network: {} as any,
        timer,
        clock,
        entropy,
        crypto: new BunCryptoDevice(),
        console: new BufferConsoleDevice(),
        dns: new MockDNSDevice(),
        host: new MockHostDevice(),
        ipc: new MockIPCDevice(),
        channel: new BunChannelDevice(),
        async shutdown() {
            await storage.close();
        },
    };
}

function createContext(hal: HAL, caller: string = 'test-user'): ModelContext {
    return {
        hal,
        caller,
        async resolve(path: string): Promise<string | null> {
            return null;
        },
        async getEntity(id: string): Promise<ModelStat | null> {
            const data = await hal.storage.get(`entity:${id}`);
            if (!data) return null;
            return JSON.parse(new TextDecoder().decode(data));
        },
        async computePath(id: string): Promise<string> {
            return '/unknown';
        },
    };
}

describe('FileModel', () => {
    let hal: HAL;
    let ctx: ModelContext;
    let model: FileModel;
    let entityCache: EntityCache & { addEntity: (entity: any) => void };
    const ROOT_ID = '00000000-0000-0000-0000-000000000000';

    beforeEach(async () => {
        hal = createMockHAL();
        ctx = createContext(hal);
        const mockDbOps = createMockDatabaseOps();
        entityCache = createMockEntityCache() as EntityCache & { addEntity: (entity: any) => void };
        model = new FileModel(mockDbOps, entityCache);
    });

    describe('name', () => {
        it('should be "file"', () => {
            expect(model.name).toBe('file');
        });
    });

    describe('fields', () => {
        it('should return field definitions', () => {
            const fields = model.fields();
            expect(fields.length).toBeGreaterThan(0);

            // With entity+detail architecture, fields() returns detail table fields
            // Entity fields (id, model, parent, pathname) are in entities table
            const names = fields.map((f) => f.name);
            expect(names).toContain('id');
            expect(names).toContain('owner');
        });
    });

    describe('create', () => {
        it('should create file entity', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            expect(id).toBeDefined();
            expect(typeof id).toBe('string');
            expect(id.length).toBeGreaterThan(0);
        });

        it('should store entity in storage', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            const data = await hal.storage.get(`entity:${id}`);
            expect(data).not.toBeNull();

            const entity = JSON.parse(new TextDecoder().decode(data!));
            expect(entity.name).toBe('test.txt');
            expect(entity.model).toBe('file');
            expect(entity.parent).toBe(ROOT_ID);
        });

        it('should create empty data blob', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            const entity = await ctx.getEntity(id);
            expect(entity).toBeDefined();

            // With entity+detail architecture, blob is stored at blob:model:id
            const data = await hal.storage.get(`blob:file:${id}`);
            expect(data).toEqual(new Uint8Array(0));
        });

        it('should set owner', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt', { owner: 'custom-owner' });
            const entity = await ctx.getEntity(id);
            expect(entity!.owner).toBe('custom-owner');
        });

        it('should set timestamps', async () => {
            const before = hal.clock.now();
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            const entity = await ctx.getEntity(id);

            expect(entity!.ctime).toBeGreaterThanOrEqual(before);
            expect(entity!.mtime).toBeGreaterThanOrEqual(before);
            expect(entity!.ctime).toBe(entity!.mtime);
        });
    });

    describe('stat', () => {
        it('should return entity metadata', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            const stat = await model.stat(ctx, id);

            expect(stat.id).toBe(id);
            expect(stat.name).toBe('test.txt');
            expect(stat.model).toBe('file');
            expect(stat.size).toBe(0);
        });

        it('should throw for non-existent entity', async () => {
            await expect(model.stat(ctx, 'non-existent-id')).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('setstat', () => {
        it('should update name', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            await model.setstat(ctx, id, { name: 'renamed.txt' });

            const stat = await model.stat(ctx, id);
            expect(stat.name).toBe('renamed.txt');
        });

        it('should update mtime', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            const stat1 = await model.stat(ctx, id);

            (hal.clock as MockClockDevice).advance(1000);
            await model.setstat(ctx, id, {});

            const stat2 = await model.stat(ctx, id);
            expect(stat2.mtime).toBeGreaterThan(stat1.mtime);
        });
    });

    describe('open', () => {
        it('should return file handle', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            const handle = await model.open(ctx, id, { read: true });

            expect(handle).toBeDefined();
            expect(handle.closed).toBe(false);
            await handle.close();
        });

        it('should throw for non-existent file', async () => {
            await expect(model.open(ctx, 'missing', { read: true })).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('unlink', () => {
        it('should delete entity and data blob', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');

            await model.unlink(ctx, id);

            // With entity+detail architecture, blob is stored at blob:model:id
            expect(await hal.storage.get(`entity:${id}`)).toBeNull();
            expect(await hal.storage.get(`blob:file:${id}`)).toBeNull();
        });

        it('should throw for non-existent file', async () => {
            await expect(model.unlink(ctx, 'missing')).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('list', () => {
        it('should return empty (files have no children)', async () => {
            const id = await model.create(ctx, ROOT_ID, 'test.txt');
            const children: string[] = [];

            for await (const child of model.list(ctx, id)) {
                children.push(child);
            }

            expect(children).toEqual([]);
        });
    });
});

describe('FolderModel', () => {
    let hal: HAL;
    let ctx: ModelContext;
    let model: FolderModel;
    let fileModel: FileModel;
    let entityCache: EntityCache & { addEntity: (entity: any) => void };
    const ROOT_ID = '00000000-0000-0000-0000-000000000000';

    beforeEach(async () => {
        hal = createMockHAL();
        ctx = createContext(hal);
        const mockDbOps = createMockDatabaseOps();
        entityCache = createMockEntityCache() as EntityCache & { addEntity: (entity: any) => void };
        model = new FolderModel(mockDbOps, entityCache);
        fileModel = new FileModel(mockDbOps, entityCache);
    });

    describe('name', () => {
        it('should be "folder"', () => {
            expect(model.name).toBe('folder');
        });
    });

    describe('fields', () => {
        it('should return field definitions', () => {
            const fields = model.fields();
            expect(fields.length).toBeGreaterThan(0);

            // With entity+detail architecture, fields() returns detail table fields
            // Entity fields (id, model, parent, pathname) are in entities table
            const names = fields.map((f) => f.name);
            expect(names).toContain('id');
            expect(names).toContain('owner');
        });
    });

    describe('create', () => {
        it('should create folder entity', async () => {
            const id = await model.create(ctx, ROOT_ID, 'folder');
            expect(id).toBeDefined();

            const entity = await ctx.getEntity(id);
            expect(entity!.model).toBe('folder');
            expect(entity!.name).toBe('folder');
        });

        it('should set owner', async () => {
            const id = await model.create(ctx, ROOT_ID, 'folder', { owner: 'custom' });
            const entity = await ctx.getEntity(id);
            expect(entity!.owner).toBe('custom');
        });
    });

    describe('stat', () => {
        it('should return folder metadata with size 0', async () => {
            const id = await model.create(ctx, ROOT_ID, 'folder');
            const stat = await model.stat(ctx, id);

            expect(stat.model).toBe('folder');
            expect(stat.size).toBe(0);
        });

        it('should throw for non-existent folder', async () => {
            await expect(model.stat(ctx, 'missing')).rejects.toBeInstanceOf(ENOENT);
        });
    });

    describe('open', () => {
        it('should throw EISDIR', async () => {
            const id = await model.create(ctx, ROOT_ID, 'folder');
            await expect(model.open(ctx, id, { read: true })).rejects.toBeInstanceOf(EISDIR);
        });
    });

    describe('list', () => {
        it('should list children', async () => {
            const folderId = await model.create(ctx, ROOT_ID, 'folder');

            // Create children using shared fileModel
            const file1 = await fileModel.create(ctx, folderId, 'file1.txt');
            const file2 = await fileModel.create(ctx, folderId, 'file2.txt');

            const children: string[] = [];
            for await (const id of model.list(ctx, folderId)) {
                children.push(id);
            }

            expect(children).toContain(file1);
            expect(children).toContain(file2);
        });

        it('should return empty for empty folder', async () => {
            const folderId = await model.create(ctx, ROOT_ID, 'folder');

            const children: string[] = [];
            for await (const id of model.list(ctx, folderId)) {
                children.push(id);
            }

            expect(children).toEqual([]);
        });
    });

    describe('unlink', () => {
        it('should delete empty folder', async () => {
            const id = await model.create(ctx, ROOT_ID, 'folder');
            await model.unlink(ctx, id);

            expect(await hal.storage.get(`entity:${id}`)).toBeNull();
        });

        it('should throw for non-empty folder', async () => {
            const folderId = await model.create(ctx, ROOT_ID, 'folder');

            // Create child using shared fileModel
            await fileModel.create(ctx, folderId, 'file.txt');

            await expect(model.unlink(ctx, folderId)).rejects.toBeInstanceOf(ENOTEMPTY);
        });
    });

    describe('setstat', () => {
        it('should update name', async () => {
            const id = await model.create(ctx, ROOT_ID, 'folder');
            await model.setstat(ctx, id, { name: 'renamed' });

            const stat = await model.stat(ctx, id);
            expect(stat.name).toBe('renamed');
        });
    });
});
