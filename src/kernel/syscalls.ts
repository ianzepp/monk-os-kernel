/**
 * Syscall Dispatch
 *
 * Routes syscall requests to appropriate handlers.
 */

import type { HAL } from '@src/hal/index.js';
import type { VFS, SeekWhence } from '@src/vfs/index.js';
import type { Process, OpenFlags } from '@src/kernel/types.js';
import { ENOSYS } from '@src/kernel/errors.js';

/**
 * Syscall handler function type
 */
export type SyscallHandler = (
    proc: Process,
    ...args: unknown[]
) => Promise<unknown> | unknown;

/**
 * Syscall registry
 */
export interface SyscallRegistry {
    [name: string]: SyscallHandler;
}

/**
 * Syscall dispatcher
 *
 * Routes syscall names to handler functions.
 * Handlers are registered by the kernel during initialization.
 */
export class SyscallDispatcher {
    private handlers: SyscallRegistry = {};

    /**
     * Register a syscall handler.
     */
    register(name: string, handler: SyscallHandler): void {
        this.handlers[name] = handler;
    }

    /**
     * Register multiple syscall handlers.
     */
    registerAll(handlers: SyscallRegistry): void {
        for (const [name, handler] of Object.entries(handlers)) {
            this.handlers[name] = handler;
        }
    }

    /**
     * Dispatch a syscall.
     *
     * @param proc - Calling process
     * @param name - Syscall name
     * @param args - Syscall arguments
     * @returns Syscall result
     * @throws ENOSYS if syscall not found
     */
    async dispatch(proc: Process, name: string, args: unknown[]): Promise<unknown> {
        const handler = this.handlers[name];
        if (!handler) {
            throw new ENOSYS(`Function not implemented: ${name}`);
        }

        return handler(proc, ...args);
    }

    /**
     * Check if a syscall is registered.
     */
    has(name: string): boolean {
        return name in this.handlers;
    }

    /**
     * Get list of registered syscalls.
     */
    list(): string[] {
        return Object.keys(this.handlers);
    }
}

/**
 * Create file operation syscalls.
 *
 * @param vfs - VFS instance
 * @param hal - HAL instance
 * @param getHandle - Function to get file handle from fd
 * @param setHandle - Function to set file handle for fd
 * @param closeHandle - Function to close fd
 */
export function createFileSyscalls(
    vfs: VFS,
    hal: HAL,
    getHandle: (proc: Process, fd: number) => import('@src/vfs/index.js').FileHandle | undefined,
    setHandle: (proc: Process, fd: number, resourceId: string) => void,
    closeHandle: (proc: Process, fd: number) => Promise<void>
): SyscallRegistry {
    return {
        async open(proc: Process, path: unknown, flags: unknown): Promise<number> {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            const openFlags: OpenFlags = typeof flags === 'object' && flags !== null
                ? flags as OpenFlags
                : { read: true };

            const handle = await vfs.open(path, openFlags, proc.id);
            const fd = proc.nextFd++;
            proc.fds.set(fd, handle.id);

            return fd;
        },

        async close(proc: Process, fd: unknown): Promise<void> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }
            await closeHandle(proc, fd);
        },

        async read(proc: Process, fd: unknown, size?: unknown): Promise<Uint8Array> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            const readSize = typeof size === 'number' ? size : undefined;
            return handle.read(readSize);
        },

        async write(proc: Process, fd: unknown, data: unknown): Promise<number> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            if (!(data instanceof Uint8Array)) {
                throw new Error('EINVAL: data must be Uint8Array');
            }

            return handle.write(data);
        },

        async seek(proc: Process, fd: unknown, offset: unknown, whence: unknown): Promise<number> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            if (typeof offset !== 'number') {
                throw new Error('EINVAL: offset must be a number');
            }

            const seekWhence: SeekWhence = (whence as SeekWhence) || 'start';
            return handle.seek(offset, seekWhence);
        },

        async stat(proc: Process, path: unknown): Promise<unknown> {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            return vfs.stat(path, proc.id);
        },

        async fstat(proc: Process, fd: unknown): Promise<unknown> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            // Get stat via path stored on handle
            return vfs.stat(handle.path, proc.id);
        },

        async mkdir(proc: Process, path: unknown): Promise<void> {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            await vfs.mkdir(path, proc.id);
        },

        async unlink(proc: Process, path: unknown): Promise<void> {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            await vfs.unlink(path, proc.id);
        },

        async rmdir(proc: Process, path: unknown): Promise<void> {
            // rmdir is same as unlink for directories
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            await vfs.unlink(path, proc.id);
        },

        async readdir(proc: Process, path: unknown): Promise<string[]> {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            const entries: string[] = [];
            for await (const entry of vfs.readdir(path, proc.id)) {
                entries.push(entry.name);
            }
            return entries;
        },

        async rename(proc: Process, oldPath: unknown, newPath: unknown): Promise<void> {
            if (typeof oldPath !== 'string' || typeof newPath !== 'string') {
                throw new Error('EINVAL: paths must be strings');
            }

            // TODO: Implement rename in VFS
            throw new ENOSYS('rename');
        },

        async access(proc: Process, path: unknown, acl?: unknown): Promise<unknown> {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            if (acl !== undefined) {
                // Set ACL
                await vfs.setAccess(path, proc.id, acl as import('@src/vfs/index.js').ACL | null);
                return;
            }

            // Get ACL
            return vfs.access(path, proc.id);
        },
    };
}

/**
 * Create miscellaneous syscalls.
 */
export function createMiscSyscalls(): SyscallRegistry {
    return {
        getcwd(proc: Process): string {
            return proc.cwd;
        },

        chdir(proc: Process, path: unknown): void {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }
            // TODO: Verify path exists and is a directory
            proc.cwd = path;
        },

        getenv(proc: Process, name: unknown): string | undefined {
            if (typeof name !== 'string') {
                throw new Error('EINVAL: name must be a string');
            }
            return proc.env[name];
        },

        setenv(proc: Process, name: unknown, value: unknown): void {
            if (typeof name !== 'string') {
                throw new Error('EINVAL: name must be a string');
            }
            if (typeof value !== 'string') {
                throw new Error('EINVAL: value must be a string');
            }
            proc.env[name] = value;
        },
    };
}
