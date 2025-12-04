/**
 * Syscall Dispatcher Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SyscallDispatcher, createMiscSyscalls } from '@src/kernel/syscalls.js';
import type { Process } from '@src/kernel/types.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { ModelStat } from '@src/vfs/model.js';
import { unwrapStream } from '@src/message.js';
import { respond } from '@src/message.js';
import { ENOENT } from '@src/hal/errors.js';

/**
 * Create a mock process for testing
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        worker: {} as Worker,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/home/test',
        env: { HOME: '/home/test', PATH: '/bin' },
        args: [],
        pathDirs: new Map([['00-bin', '/bin']]),
        handles: new Map(),
        nextHandle: 3,
        children: new Map(),
        nextPid: 1,
        activeStreams: new Map(),
        streamPingHandlers: new Map(),
        ...overrides,
    };
}

describe('SyscallDispatcher', () => {
    let dispatcher: SyscallDispatcher;

    beforeEach(() => {
        dispatcher = new SyscallDispatcher();
    });

    describe('register', () => {
        it('should register a syscall handler', () => {
            dispatcher.register('test', async function* () { yield respond.ok('result'); });
            expect(dispatcher.has('test')).toBe(true);
        });
    });

    describe('registerAll', () => {
        it('should register multiple handlers', () => {
            dispatcher.registerAll({
                foo: async function* () { yield respond.ok('foo'); },
                bar: async function* () { yield respond.ok('bar'); },
            });

            expect(dispatcher.has('foo')).toBe(true);
            expect(dispatcher.has('bar')).toBe(true);
        });
    });

    describe('dispatch', () => {
        it('should call the registered handler', async () => {
            const proc = createMockProcess();
            dispatcher.register('add', async function* (_proc, a, b) {
                yield respond.ok((a as number) + (b as number));
            });

            const result = await unwrapStream<number>(dispatcher.dispatch(proc, 'add', [1, 2]));
            expect(result).toBe(3);
        });

        it('should return error for unknown syscall', async () => {
            const proc = createMockProcess();

            await expect(unwrapStream(dispatcher.dispatch(proc, 'unknown', []))).rejects.toThrow('not implemented');
        });

        it('should pass process to handler', async () => {
            const proc = createMockProcess({ cwd: '/special' });
            dispatcher.register('getcwd', async function* (p) { yield respond.ok(p.cwd); });

            const result = await unwrapStream<string>(dispatcher.dispatch(proc, 'getcwd', []));
            expect(result).toBe('/special');
        });
    });

    describe('list', () => {
        it('should return registered syscall names', () => {
            dispatcher.registerAll({
                alpha: async function* () { yield respond.ok(); },
                beta: async function* () { yield respond.ok(); },
            });

            const list = dispatcher.list();
            expect(list).toContain('alpha');
            expect(list).toContain('beta');
        });
    });
});

describe('Misc Syscalls', () => {
    let dispatcher: SyscallDispatcher;
    let mockVfs: VFS;

    beforeEach(() => {
        // Create mock VFS that returns folder for /tmp, ENOENT for /nonexistent
        mockVfs = {
            stat: async (path: string, _caller: string): Promise<ModelStat> => {
                if (path === '/' || path === '/tmp' || path === '/home/user') {
                    return {
                        id: 'mock-id',
                        model: 'folder',
                        name: path.split('/').pop() || '',
                        parent: null,
                        owner: 'root',
                        size: 0,
                        mtime: Date.now(),
                        ctime: Date.now(),
                    };
                }
                if (path === '/etc/passwd') {
                    return {
                        id: 'mock-file-id',
                        model: 'file',
                        name: 'passwd',
                        parent: null,
                        owner: 'root',
                        size: 100,
                        mtime: Date.now(),
                        ctime: Date.now(),
                    };
                }
                throw new ENOENT(`No such file: ${path}`);
            },
        } as VFS;

        dispatcher = new SyscallDispatcher();
        dispatcher.registerAll(createMiscSyscalls(mockVfs));
    });

    describe('proc:getcwd', () => {
        it('should return current working directory', async () => {
            const proc = createMockProcess({ cwd: '/home/user' });
            const result = await unwrapStream<string>(dispatcher.dispatch(proc, 'proc:getcwd', []));
            expect(result).toBe('/home/user');
        });
    });

    describe('proc:chdir', () => {
        it('should change working directory to valid folder', async () => {
            const proc = createMockProcess({ cwd: '/home/user' });
            await unwrapStream(dispatcher.dispatch(proc, 'proc:chdir', ['/tmp']));
            expect(proc.cwd).toBe('/tmp');
        });

        it('should throw EINVAL on non-string path', async () => {
            const proc = createMockProcess();
            await expect(unwrapStream(dispatcher.dispatch(proc, 'proc:chdir', [123]))).rejects.toThrow('path must be a string');
        });

        it('should throw ENOENT on non-existent path', async () => {
            const proc = createMockProcess();
            await expect(unwrapStream(dispatcher.dispatch(proc, 'proc:chdir', ['/nonexistent']))).rejects.toThrow('No such file');
        });

        it('should throw ENOTDIR on file path', async () => {
            const proc = createMockProcess();
            await expect(unwrapStream(dispatcher.dispatch(proc, 'proc:chdir', ['/etc/passwd']))).rejects.toThrow('Not a directory');
        });

        it('should resolve relative paths against cwd', async () => {
            const proc = createMockProcess({ cwd: '/home/user' });
            await unwrapStream(dispatcher.dispatch(proc, 'proc:chdir', ['../..']));
            expect(proc.cwd).toBe('/');
        });
    });

    describe('proc:getenv', () => {
        it('should return environment variable', async () => {
            const proc = createMockProcess({ env: { FOO: 'bar' } });
            const result = await unwrapStream<string>(dispatcher.dispatch(proc, 'proc:getenv', ['FOO']));
            expect(result).toBe('bar');
        });

        it('should return undefined for missing variable', async () => {
            const proc = createMockProcess({ env: {} });
            const result = await unwrapStream<string | undefined>(dispatcher.dispatch(proc, 'proc:getenv', ['MISSING']));
            expect(result).toBeUndefined();
        });
    });

    describe('proc:setenv', () => {
        it('should set environment variable', async () => {
            const proc = createMockProcess({ env: {} });
            await unwrapStream(dispatcher.dispatch(proc, 'proc:setenv', ['FOO', 'bar']));
            expect(proc.env.FOO).toBe('bar');
        });

        it('should throw EINVAL on non-string name', async () => {
            const proc = createMockProcess();
            await expect(unwrapStream(dispatcher.dispatch(proc, 'proc:setenv', [123, 'value']))).rejects.toThrow('name must be a string');
        });

        it('should throw EINVAL on non-string value', async () => {
            const proc = createMockProcess();
            await expect(unwrapStream(dispatcher.dispatch(proc, 'proc:setenv', ['name', 123]))).rejects.toThrow('value must be a string');
        });
    });
});
