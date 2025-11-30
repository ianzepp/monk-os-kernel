/**
 * Syscall Dispatch
 *
 * Routes syscall requests to appropriate handlers.
 */

import type { HAL } from '@src/hal/index.js';
import type { VFS, SeekWhence } from '@src/vfs/index.js';
import type { Process, OpenFlags } from '@src/kernel/types.js';
import type { Resource, FileResource } from '@src/kernel/resource.js';
import { ENOSYS, EINVAL, EBADF } from '@src/kernel/errors.js';

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
                throw new EINVAL('path must be a string');
            }

            const openFlags: OpenFlags = typeof flags === 'object' && flags !== null
                ? flags as OpenFlags
                : { read: true };

            return openFile(proc, path, openFlags);
        },

        async close(proc: Process, fd: unknown): Promise<void> {
            if (typeof fd !== 'number') {
                throw new EINVAL('fd must be a number');
            }
            await closeResource(proc, fd);
        },

        async read(proc: Process, fd: unknown, size?: unknown): Promise<Uint8Array> {
            if (typeof fd !== 'number') {
                throw new EINVAL('fd must be a number');
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new EBADF(`Bad file descriptor: ${fd}`);
            }

            const readSize = typeof size === 'number' ? size : undefined;
            return resource.read(readSize);
        },

        async write(proc: Process, fd: unknown, data: unknown): Promise<number> {
            if (typeof fd !== 'number') {
                throw new EINVAL('fd must be a number');
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new EBADF(`Bad file descriptor: ${fd}`);
            }

            if (!(data instanceof Uint8Array)) {
                throw new EINVAL('data must be Uint8Array');
            }

            return resource.write(data);
        },

        async seek(proc: Process, fd: unknown, offset: unknown, whence: unknown): Promise<number> {
            if (typeof fd !== 'number') {
                throw new EINVAL('fd must be a number');
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new EBADF(`Bad file descriptor: ${fd}`);
            }

            // Only file resources support seek
            if (resource.type !== 'file') {
                throw new EINVAL('Illegal seek on socket');
            }

            if (typeof offset !== 'number') {
                throw new EINVAL('offset must be a number');
            }

            const seekWhence: SeekWhence = (whence as SeekWhence) || 'start';
            return (resource as FileResource).getHandle().seek(offset, seekWhence);
        },

        async stat(proc: Process, path: unknown): Promise<unknown> {
            if (typeof path !== 'string') {
                throw new EINVAL('path must be a string');
            }

            return vfs.stat(path, proc.id);
        },

        async fstat(proc: Process, fd: unknown): Promise<unknown> {
            if (typeof fd !== 'number') {
                throw new EINVAL('fd must be a number');
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                throw new EBADF(`Bad file descriptor: ${fd}`);
            }

            // Only file resources have path-based stat
            if (resource.type !== 'file') {
                throw new EINVAL('fstat not supported on sockets');
            }

            return vfs.stat(resource.description, proc.id);
        },

        async mkdir(proc: Process, path: unknown, opts?: unknown): Promise<void> {
            if (typeof path !== 'string') {
                throw new EINVAL('path must be a string');
            }

            const options = opts as { recursive?: boolean } | undefined;
            await vfs.mkdir(path, proc.id, options);
        },

        async unlink(proc: Process, path: unknown): Promise<void> {
            if (typeof path !== 'string') {
                throw new EINVAL('path must be a string');
            }

            await vfs.unlink(path, proc.id);
        },

        async rmdir(proc: Process, path: unknown): Promise<void> {
            // rmdir is same as unlink for directories
            if (typeof path !== 'string') {
                throw new EINVAL('path must be a string');
            }

            await vfs.unlink(path, proc.id);
        },

        async readdir(proc: Process, path: unknown): Promise<string[]> {
            if (typeof path !== 'string') {
                throw new EINVAL('path must be a string');
            }

            const entries: string[] = [];
            for await (const entry of vfs.readdir(path, proc.id)) {
                entries.push(entry.name);
            }
            return entries;
        },

        async rename(proc: Process, oldPath: unknown, newPath: unknown): Promise<void> {
            if (typeof oldPath !== 'string' || typeof newPath !== 'string') {
                throw new EINVAL('paths must be strings');
            }

            // TODO: Implement rename in VFS
            throw new ENOSYS('rename');
        },

        async access(proc: Process, path: unknown, acl?: unknown): Promise<unknown> {
            if (typeof path !== 'string') {
                throw new EINVAL('path must be a string');
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
        getargs(proc: Process): string[] {
            return proc.args;
        },

        getcwd(proc: Process): string {
            return proc.cwd;
        },

        chdir(proc: Process, path: unknown): void {
            if (typeof path !== 'string') {
                throw new EINVAL('path must be a string');
            }
            // TODO: Verify path exists and is a directory
            proc.cwd = path;
        },

        getenv(proc: Process, name: unknown): string | undefined {
            if (typeof name !== 'string') {
                throw new EINVAL('name must be a string');
            }
            return proc.env[name];
        },

        setenv(proc: Process, name: unknown, value: unknown): void {
            if (typeof name !== 'string') {
                throw new EINVAL('name must be a string');
            }
            if (typeof value !== 'string') {
                throw new EINVAL('value must be a string');
            }
            proc.env[name] = value;
        },
    };
}

/**
 * Port message returned to process.
 *
 * For tcp:listen: fd is the accepted connection
 * For udp/pubsub/watch: data is the payload
 */
export interface ProcessPortMessage {
    /** Source identifier */
    from: string;

    /** File descriptor for accepted connections (tcp:listen) */
    fd?: number;

    /** Payload data (udp, pubsub, watch) */
    data?: Uint8Array;

    /** Optional metadata */
    meta?: Record<string, unknown>;
}

/**
 * Create network syscalls.
 *
 * @param hal - HAL instance
 * @param connectTcp - Function to connect and allocate fd for socket
 * @param createPort - Function to create a port and allocate port id
 * @param getPort - Function to get port from port id
 * @param recvPort - Function to receive from port (auto-allocates fd for sockets)
 * @param closePort - Function to close port
 */
export function createNetworkSyscalls(
    hal: HAL,
    connectTcp: (proc: Process, host: string, port: number) => Promise<number>,
    createPort: (proc: Process, type: string, opts: unknown) => Promise<number>,
    getPort: (proc: Process, portId: number) => import('./resource.js').Port | undefined,
    recvPort: (proc: Process, portId: number) => Promise<ProcessPortMessage>,
    closePort: (proc: Process, portId: number) => Promise<void>
): SyscallRegistry {
    return {
        async connect(proc: Process, proto: unknown, host: unknown, port: unknown): Promise<number> {
            if (typeof proto !== 'string') {
                throw new EINVAL('proto must be a string');
            }
            if (typeof host !== 'string') {
                throw new EINVAL('host must be a string');
            }

            switch (proto) {
                case 'tcp':
                    if (typeof port !== 'number') {
                        throw new EINVAL('port must be a number');
                    }
                    return connectTcp(proc, host, port);

                case 'unix':
                    // Unix sockets use path as host, port=0
                    return connectTcp(proc, host, 0);

                default:
                    throw new EINVAL(`unsupported protocol: ${proto}`);
            }
        },

        async port(proc: Process, type: unknown, opts: unknown): Promise<number> {
            if (typeof type !== 'string') {
                throw new EINVAL('type must be a string');
            }

            return createPort(proc, type, opts);
        },

        async recv(proc: Process, portId: unknown): Promise<ProcessPortMessage> {
            if (typeof portId !== 'number') {
                throw new EINVAL('portId must be a number');
            }

            const port = getPort(proc, portId);
            if (!port) {
                throw new EBADF(`Bad port: ${portId}`);
            }

            return recvPort(proc, portId);
        },

        async send(proc: Process, portId: unknown, to: unknown, data: unknown): Promise<void> {
            if (typeof portId !== 'number') {
                throw new EINVAL('portId must be a number');
            }
            if (typeof to !== 'string') {
                throw new EINVAL('to must be a string');
            }
            if (!(data instanceof Uint8Array)) {
                throw new EINVAL('data must be Uint8Array');
            }

            const port = getPort(proc, portId);
            if (!port) {
                throw new EBADF(`Bad port: ${portId}`);
            }

            await port.send(to, data);
        },

        async pclose(proc: Process, portId: unknown): Promise<void> {
            if (typeof portId !== 'number') {
                throw new EINVAL('portId must be a number');
            }

            await closePort(proc, portId);
        },
    };
}
