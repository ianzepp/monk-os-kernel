/**
 * Syscall Dispatcher Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SyscallDispatcher, createMiscSyscalls } from '@src/kernel/syscalls.js';
import type { Process } from '@src/kernel/types.js';
import { EINVAL } from '@src/kernel/errors.js';

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
        fds: new Map(),
        ports: new Map(),
        nextFd: 3,
        nextPort: 0,
        children: new Map(),
        nextPid: 1,
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
            dispatcher.register('test', () => 'result');
            expect(dispatcher.has('test')).toBe(true);
        });
    });

    describe('registerAll', () => {
        it('should register multiple handlers', () => {
            dispatcher.registerAll({
                foo: () => 'foo',
                bar: () => 'bar',
            });

            expect(dispatcher.has('foo')).toBe(true);
            expect(dispatcher.has('bar')).toBe(true);
        });
    });

    describe('dispatch', () => {
        it('should call the registered handler', async () => {
            const proc = createMockProcess();
            dispatcher.register('add', (_proc, a, b) => (a as number) + (b as number));

            const result = await dispatcher.dispatch(proc, 'add', [1, 2]);
            expect(result).toBe(3);
        });

        it('should throw ENOSYS for unknown syscall', async () => {
            const proc = createMockProcess();

            await expect(dispatcher.dispatch(proc, 'unknown', [])).rejects.toThrow('not implemented');
        });

        it('should pass process to handler', async () => {
            const proc = createMockProcess({ cwd: '/special' });
            dispatcher.register('getcwd', (p) => p.cwd);

            const result = await dispatcher.dispatch(proc, 'getcwd', []);
            expect(result).toBe('/special');
        });
    });

    describe('list', () => {
        it('should return registered syscall names', () => {
            dispatcher.registerAll({
                alpha: () => {},
                beta: () => {},
            });

            const list = dispatcher.list();
            expect(list).toContain('alpha');
            expect(list).toContain('beta');
        });
    });
});

describe('Misc Syscalls', () => {
    let dispatcher: SyscallDispatcher;

    beforeEach(() => {
        dispatcher = new SyscallDispatcher();
        dispatcher.registerAll(createMiscSyscalls());
    });

    describe('getcwd', () => {
        it('should return current working directory', async () => {
            const proc = createMockProcess({ cwd: '/home/user' });
            const result = await dispatcher.dispatch(proc, 'getcwd', []);
            expect(result).toBe('/home/user');
        });
    });

    describe('chdir', () => {
        it('should change working directory', async () => {
            const proc = createMockProcess({ cwd: '/home/user' });
            await dispatcher.dispatch(proc, 'chdir', ['/tmp']);
            expect(proc.cwd).toBe('/tmp');
        });

        it('should throw EINVAL on non-string path', async () => {
            const proc = createMockProcess();
            await expect(dispatcher.dispatch(proc, 'chdir', [123])).rejects.toBeInstanceOf(EINVAL);
        });
    });

    describe('getenv', () => {
        it('should return environment variable', async () => {
            const proc = createMockProcess({ env: { FOO: 'bar' } });
            const result = await dispatcher.dispatch(proc, 'getenv', ['FOO']);
            expect(result).toBe('bar');
        });

        it('should return undefined for missing variable', async () => {
            const proc = createMockProcess({ env: {} });
            const result = await dispatcher.dispatch(proc, 'getenv', ['MISSING']);
            expect(result).toBeUndefined();
        });
    });

    describe('setenv', () => {
        it('should set environment variable', async () => {
            const proc = createMockProcess({ env: {} });
            await dispatcher.dispatch(proc, 'setenv', ['FOO', 'bar']);
            expect(proc.env.FOO).toBe('bar');
        });

        it('should throw EINVAL on non-string name', async () => {
            const proc = createMockProcess();
            await expect(dispatcher.dispatch(proc, 'setenv', [123, 'value'])).rejects.toBeInstanceOf(EINVAL);
        });

        it('should throw EINVAL on non-string value', async () => {
            const proc = createMockProcess();
            await expect(dispatcher.dispatch(proc, 'setenv', ['name', 123])).rejects.toBeInstanceOf(EINVAL);
        });
    });
});
