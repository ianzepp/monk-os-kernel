/**
 * VFS Syscall Tests
 *
 * Tests for file system syscall validation and behavior.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
    fileOpen, fileClose, fileRead, fileWrite, fileSeek,
    fileStat, fileFstat, fileMkdir, fileUnlink, fileRmdir,
    fileReaddir, fileRename, fileSymlink, fileAccess,
    fileRecv, fileSend, fsMount, fsUmount,
} from '@src/syscall/vfs.js';
import type { Process } from '@src/kernel/types.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { Response } from '@src/message.js';

/**
 * Create a mock process for testing.
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        user: 'test',
        worker: {} as Worker,
        virtual: false,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/home/test',
        env: {},
        args: [],
        pathDirs: new Map(),
        handles: new Map(),
        nextHandle: 3,
        children: new Map(),
        nextPid: 1,
        activeStreams: new Map(),
        streamPingHandlers: new Map(),
        ...overrides,
    };
}

/**
 * Get first response from an async iterable.
 */
async function firstResponse(iterable: AsyncIterable<Response>): Promise<Response> {
    for await (const response of iterable) {
        return response;
    }

    throw new Error('No response received');
}

/**
 * Collect all responses from an async iterable.
 */
async function collectResponses(iterable: AsyncIterable<Response>): Promise<Response[]> {
    const responses: Response[] = [];

    for await (const response of iterable) {
        responses.push(response);
    }

    return responses;
}

describe('VFS Syscalls - fileOpen', () => {
    let proc: Process;
    let mockKernel: Kernel;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
        mockVfs = {} as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(fileOpen(proc, mockKernel, mockVfs, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should yield EINVAL when path is null', async () => {
        const response = await firstResponse(fileOpen(proc, mockKernel, mockVfs, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });

    it('should yield EINVAL when path is undefined', async () => {
        const response = await firstResponse(fileOpen(proc, mockKernel, mockVfs, undefined));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('VFS Syscalls - fileClose', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(fileClose(proc, mockKernel, 'string'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });

    it('should yield EINVAL when fd is null', async () => {
        const response = await firstResponse(fileClose(proc, mockKernel, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
    });
});

describe('VFS Syscalls - fileRead', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(fileRead(proc, mockKernel, 'string'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('VFS Syscalls - fileWrite', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(fileWrite(proc, mockKernel, null, 'data'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('VFS Syscalls - fileSeek', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(fileSeek(proc, mockKernel, 'invalid', 0));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('VFS Syscalls - fileStat', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {
            stat: mock(() => Promise.resolve({
                id: 'test-id',
                model: 'file',
                name: 'test.txt',
                parent: null,
                owner: 'test',
                size: 100,
                mtime: Date.now(),
                ctime: Date.now(),
            })),
        } as unknown as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(fileStat(proc, mockVfs, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should yield ok with stat data on success', async () => {
        const response = await firstResponse(fileStat(proc, mockVfs, '/test.txt'));

        expect(response.op).toBe('ok');
        expect((response.data as { id: string }).id).toBe('test-id');
    });

    it('should pass user identity to VFS', async () => {
        proc.user = 'alice';

        await firstResponse(fileStat(proc, mockVfs, '/test.txt'));

        expect(mockVfs.stat).toHaveBeenCalledWith('/test.txt', 'alice');
    });
});

describe('VFS Syscalls - fileFstat', () => {
    let proc: Process;
    let mockKernel: Kernel;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
        mockVfs = {} as VFS;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(fileFstat(proc, mockKernel, mockVfs, 'string'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('VFS Syscalls - fileMkdir', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {
            mkdir: mock(() => Promise.resolve()),
        } as unknown as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(fileMkdir(proc, mockVfs, 123));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should yield ok on success', async () => {
        const response = await firstResponse(fileMkdir(proc, mockVfs, '/new-dir'));

        expect(response.op).toBe('ok');
    });

    it('should pass options to VFS', async () => {
        await firstResponse(fileMkdir(proc, mockVfs, '/new-dir', { recursive: true }));

        expect(mockVfs.mkdir).toHaveBeenCalledWith('/new-dir', 'test', { recursive: true });
    });
});

describe('VFS Syscalls - fileUnlink', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {
            unlink: mock(() => Promise.resolve()),
        } as unknown as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(fileUnlink(proc, mockVfs, null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should yield ok on success', async () => {
        const response = await firstResponse(fileUnlink(proc, mockVfs, '/file.txt'));

        expect(response.op).toBe('ok');
    });
});

describe('VFS Syscalls - fileRmdir', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {
            unlink: mock(() => Promise.resolve()),
        } as unknown as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(fileRmdir(proc, mockVfs, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });
});

describe('VFS Syscalls - fileReaddir', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {
            readdir: mock(() => (async function* () {
                yield { name: 'file1.txt', model: 'file' };
                yield { name: 'file2.txt', model: 'file' };
            })()),
        } as unknown as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(fileReaddir(proc, mockVfs, undefined));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should stream directory entries as items', async () => {
        const responses = await collectResponses(fileReaddir(proc, mockVfs, '/dir'));

        expect(responses.length).toBe(3);
        expect(responses[0]!.op).toBe('item');
        expect(responses[0]!.data).toEqual({ name: 'file1.txt', model: 'file' });
        expect(responses[1]!.op).toBe('item');
        expect(responses[1]!.data).toEqual({ name: 'file2.txt', model: 'file' });
        expect(responses[2]!.op).toBe('done');
    });
});

describe('VFS Syscalls - fileRename', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {} as VFS;
    });

    it('should yield EINVAL when oldPath is not a string', async () => {
        const response = await firstResponse(fileRename(proc, mockVfs, 123, '/new'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('paths must be strings');
    });

    it('should yield EINVAL when newPath is not a string', async () => {
        const response = await firstResponse(fileRename(proc, mockVfs, '/old', 456));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('paths must be strings');
    });

    it('should yield ENOSYS (not implemented)', async () => {
        const response = await firstResponse(fileRename(proc, mockVfs, '/old', '/new'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('ENOSYS');
    });
});

describe('VFS Syscalls - fileSymlink', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {
            symlink: mock(() => Promise.resolve()),
        } as unknown as VFS;
    });

    it('should yield EINVAL when target is not a string', async () => {
        const response = await firstResponse(fileSymlink(proc, mockVfs, 123, '/link'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('target must be a string');
    });

    it('should yield EINVAL when linkPath is not a string', async () => {
        const response = await firstResponse(fileSymlink(proc, mockVfs, '/target', null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('linkPath must be a string');
    });

    it('should yield ok on success', async () => {
        const response = await firstResponse(fileSymlink(proc, mockVfs, '/target', '/link'));

        expect(response.op).toBe('ok');
    });
});

describe('VFS Syscalls - fileAccess', () => {
    let proc: Process;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockVfs = {
            access: mock(() => Promise.resolve({ read: true, write: false })),
            setAccess: mock(() => Promise.resolve()),
        } as unknown as VFS;
    });

    it('should yield EINVAL when path is not a string', async () => {
        const response = await firstResponse(fileAccess(proc, mockVfs, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('path must be a string');
    });

    it('should get ACL when acl argument is undefined', async () => {
        const response = await firstResponse(fileAccess(proc, mockVfs, '/file'));

        expect(response.op).toBe('ok');
        expect(mockVfs.access).toHaveBeenCalled();
    });

    it('should set ACL when acl argument is provided', async () => {
        const acl = { read: ['user1'], write: [] };
        const response = await firstResponse(fileAccess(proc, mockVfs, '/file', acl));

        expect(response.op).toBe('ok');
        expect(mockVfs.setAccess).toHaveBeenCalledWith('/file', 'test', acl);
    });
});

describe('VFS Syscalls - fileRecv', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(fileRecv(proc, mockKernel, 'string'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('VFS Syscalls - fileSend', () => {
    let proc: Process;
    let mockKernel: Kernel;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
    });

    it('should yield EINVAL when fd is not a number', async () => {
        const response = await firstResponse(fileSend(proc, mockKernel, null, {}));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('fd must be a number');
    });
});

describe('VFS Syscalls - fsMount', () => {
    let proc: Process;
    let mockKernel: Kernel;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
        mockVfs = {} as VFS;
    });

    it('should yield EINVAL when source is not a string', async () => {
        const response = await firstResponse(fsMount(proc, mockKernel, mockVfs, 123, '/mnt'));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('source must be a string');
    });

    it('should yield EINVAL when target is not a string', async () => {
        const response = await firstResponse(fsMount(proc, mockKernel, mockVfs, 'host:/path', null));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('target must be a string');
    });
});

describe('VFS Syscalls - fsUmount', () => {
    let proc: Process;
    let mockKernel: Kernel;
    let mockVfs: VFS;

    beforeEach(() => {
        proc = createMockProcess();
        mockKernel = {} as Kernel;
        mockVfs = {} as VFS;
    });

    it('should yield EINVAL when target is not a string', async () => {
        const response = await firstResponse(fsUmount(proc, mockKernel, mockVfs, undefined));

        expect(response.op).toBe('error');
        expect((response.data as { code: string }).code).toBe('EINVAL');
        expect((response.data as { message: string }).message).toBe('target must be a string');
    });
});
