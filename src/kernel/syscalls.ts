/**
 * Syscall Dispatch
 *
 * Routes syscall requests to appropriate handlers.
 */

import type { HAL } from '@src/hal/index.js';
import type { VFS, SeekWhence } from '@src/vfs/index.js';
import type { Process, OpenFlags } from '@src/kernel/types.js';
import type { Resource, FileResource } from '@src/kernel/resource.js';
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
 * @param getResource - Function to get resource from fd
 * @param openFile - Function to open a file and allocate fd
 * @param closeResource - Function to close fd
 */
export function createFileSyscalls(
    vfs: VFS,
    hal: HAL,
    getResource: (proc: Process, fd: number) => Resource | undefined,
    openFile: (proc: Process, path: string, flags: OpenFlags) => Promise<number>,
    closeResource: (proc: Process, fd: number) => Promise<void>
): SyscallRegistry {
    return {
        async open(proc: Process, path: unknown, flags: unknown): Promise<number> {
            if (typeof path !== 'string') {
                throw new Error('EINVAL: path must be a string');
            }

            const openFlags: OpenFlags = typeof flags === 'object' && flags !== null
                ? flags as OpenFlags
                : { read: true };

            return openFile(proc, path, openFlags);
        },

        async close(proc: Process, fd: unknown): Promise<void> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }
            await closeResource(proc, fd);
        },

        async read(proc: Process, fd: unknown, size?: unknown): Promise<Uint8Array> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            const readSize = typeof size === 'number' ? size : undefined;
            return resource.read(readSize);
        },

        async write(proc: Process, fd: unknown, data: unknown): Promise<number> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            if (!(data instanceof Uint8Array)) {
                throw new Error('EINVAL: data must be Uint8Array');
            }

            return resource.write(data);
        },

        async seek(proc: Process, fd: unknown, offset: unknown, whence: unknown): Promise<number> {
            if (typeof fd !== 'number') {
                throw new Error('EINVAL: fd must be a number');
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            // Only file resources support seek
            if (resource.type !== 'file') {
                throw new Error('ESPIPE: Illegal seek on socket');
            }

            if (typeof offset !== 'number') {
                throw new Error('EINVAL: offset must be a number');
            }

            const seekWhence: SeekWhence = (whence as SeekWhence) || 'start';
            return (resource as FileResource).getHandle().seek(offset, seekWhence);
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

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new Error(`EBADF: Bad file descriptor: ${fd}`);
            }

            // Only file resources have path-based stat
            if (resource.type !== 'file') {
                // For sockets, return socket stat
                throw new Error('EINVAL: fstat not supported on sockets');
            }

            return vfs.stat(resource.description, proc.id);
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

/**
 * Create network syscalls.
 *
 * @param hal - HAL instance
 * @param connectTcp - Function to connect and allocate fd for socket
 */
export function createNetworkSyscalls(
    hal: HAL,
    connectTcp: (proc: Process, host: string, port: number) => Promise<number>
): SyscallRegistry {
    return {
        async connect(proc: Process, proto: unknown, host: unknown, port: unknown): Promise<number> {
            if (typeof proto !== 'string') {
                throw new Error('EINVAL: proto must be a string');
            }
            if (typeof host !== 'string') {
                throw new Error('EINVAL: host must be a string');
            }
            if (typeof port !== 'number') {
                throw new Error('EINVAL: port must be a number');
            }

            if (proto !== 'tcp') {
                throw new Error(`EINVAL: unsupported protocol: ${proto}`);
            }

            return connectTcp(proc, host, port);
        },
    };
}
