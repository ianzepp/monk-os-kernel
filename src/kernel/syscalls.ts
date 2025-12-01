/**
 * Syscall Dispatch
 *
 * Routes syscall requests to appropriate handlers.
 */

import type { HAL, Channel, ChannelOpts } from '@src/hal/index.js';
import type { VFS, SeekWhence } from '@src/vfs/index.js';
import type { Process, OpenFlags } from '@src/kernel/types.js';
import { DEFAULT_CHUNK_SIZE, MAX_STREAM_BYTES, MAX_STREAM_ENTRIES } from '@src/kernel/types.js';
import type { Resource, FileResource } from '@src/kernel/resource.js';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';

/**
 * Syscall handler function type
 *
 * All handlers are async generators yielding Response objects.
 * Single-value handlers yield respond.ok(value).
 * Collection handlers yield respond.item(x) per item, then respond.done().
 */
export type SyscallHandler = (
    proc: Process,
    ...args: unknown[]
) => AsyncIterable<Response>;

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
     * @returns AsyncIterable of Response objects
     */
    dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
        const handler = this.handlers[name];
        if (!handler) {
            // Return a single-shot iterable yielding error
            return (async function* () {
                yield { op: 'error', data: { code: 'ENOSYS', message: `Function not implemented: ${name}` } } as Response;
            })();
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
    _hal: HAL,
    getResource: (proc: Process, fd: number) => Resource | undefined,
    openFile: (proc: Process, path: string, flags: OpenFlags) => Promise<number>,
    closeResource: (proc: Process, fd: number) => Promise<void>
): SyscallRegistry {
    return {
        async *open(proc: Process, path: unknown, flags: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            const openFlags: OpenFlags = typeof flags === 'object' && flags !== null
                ? flags as OpenFlags
                : { read: true };

            const fd = await openFile(proc, path, openFlags);
            yield respond.ok(fd);
        },

        async *close(proc: Process, fd: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }
            await closeResource(proc, fd);
            yield respond.ok();
        },

        async *read(proc: Process, fd: unknown, chunkSize?: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            const size = typeof chunkSize === 'number' ? chunkSize : DEFAULT_CHUNK_SIZE;
            let totalYielded = 0;

            try {
                while (true) {
                    const chunk = await resource.read(size);

                    // EOF
                    if (chunk.length === 0) {
                        break;
                    }

                    totalYielded += chunk.length;
                    if (totalYielded > MAX_STREAM_BYTES) {
                        yield respond.error('EFBIG', `Read stream exceeded ${MAX_STREAM_BYTES} bytes`);
                        return;
                    }

                    yield respond.item(chunk);

                    // Short read indicates EOF for some resources (e.g., files)
                    // For sockets/pipes, short reads are normal - only chunk.length === 0 means EOF
                    if (resource.eofOnShortRead && chunk.length < size) {
                        break;
                    }
                }

                yield respond.done();
            } catch (err) {
                yield respond.error('EIO', (err as Error).message);
            }
        },

        async *write(proc: Process, fd: unknown, data: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            if (!(data instanceof Uint8Array)) {
                yield respond.error('EINVAL', 'data must be Uint8Array');
                return;
            }

            const written = await resource.write(data);
            yield respond.ok(written);
        },

        async *seek(proc: Process, fd: unknown, offset: unknown, whence: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            // Only file resources support seek
            if (resource.type !== 'file') {
                yield respond.error('EINVAL', 'Illegal seek on socket');
                return;
            }

            if (typeof offset !== 'number') {
                yield respond.error('EINVAL', 'offset must be a number');
                return;
            }

            const seekWhence: SeekWhence = (whence as SeekWhence) || 'start';
            const pos = await (resource as FileResource).getHandle().seek(offset, seekWhence);
            yield respond.ok(pos);
        },

        async *stat(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            const statResult = await vfs.stat(path, proc.id);
            yield respond.ok(statResult);
        },

        async *fstat(proc: Process, fd: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const resource = getResource(proc, fd);
            if (!resource) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            // Only file resources have path-based stat
            if (resource.type !== 'file') {
                yield respond.error('EINVAL', 'fstat not supported on sockets');
                return;
            }

            const statResult = await vfs.stat(resource.description, proc.id);
            yield respond.ok(statResult);
        },

        async *mkdir(proc: Process, path: unknown, opts?: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            const options = opts as { recursive?: boolean } | undefined;
            await vfs.mkdir(path, proc.id, options);
            yield respond.ok();
        },

        async *unlink(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            await vfs.unlink(path, proc.id);
            yield respond.ok();
        },

        async *rmdir(proc: Process, path: unknown): AsyncIterable<Response> {
            // rmdir is same as unlink for directories
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            await vfs.unlink(path, proc.id);
            yield respond.ok();
        },

        async *readdir(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            let count = 0;
            try {
                for await (const entry of vfs.readdir(path, proc.id)) {
                    count++;
                    if (count > MAX_STREAM_ENTRIES) {
                        yield respond.error('EFBIG', `Directory listing exceeded ${MAX_STREAM_ENTRIES} entries`);
                        return;
                    }
                    yield respond.item(entry.name);
                }
                yield respond.done();
            } catch (err) {
                yield respond.error('ENOENT', (err as Error).message);
            }
        },

        async *rename(_proc: Process, oldPath: unknown, newPath: unknown): AsyncIterable<Response> {
            if (typeof oldPath !== 'string' || typeof newPath !== 'string') {
                yield respond.error('EINVAL', 'paths must be strings');
                return;
            }

            // TODO: Implement rename in VFS
            yield respond.error('ENOSYS', 'rename');
        },

        async *symlink(proc: Process, target: unknown, linkPath: unknown): AsyncIterable<Response> {
            if (typeof target !== 'string') {
                yield respond.error('EINVAL', 'target must be a string');
                return;
            }
            if (typeof linkPath !== 'string') {
                yield respond.error('EINVAL', 'linkPath must be a string');
                return;
            }

            await vfs.symlink(target, linkPath, proc.id);
            yield respond.ok();
        },

        async *access(proc: Process, path: unknown, acl?: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            if (acl !== undefined) {
                // Set ACL
                await vfs.setAccess(path, proc.id, acl as import('@src/vfs/index.js').ACL | null);
                yield respond.ok();
                return;
            }

            // Get ACL
            const result = await vfs.access(path, proc.id);
            yield respond.ok(result);
        },
    };
}

/**
 * Create miscellaneous syscalls.
 *
 * @param vfs - VFS instance for path validation
 */
export function createMiscSyscalls(vfs: VFS): SyscallRegistry {
    /**
     * Resolve a path relative to cwd if not absolute.
     */
    function resolvePath(cwd: string, path: string): string {
        if (path.startsWith('/')) {
            return path;
        }
        // Resolve relative path against cwd
        const baseParts = cwd.split('/').filter(Boolean);
        const relativeParts = path.split('/');

        for (const part of relativeParts) {
            if (part === '.' || part === '') {
                continue;
            } else if (part === '..') {
                baseParts.pop();
            } else {
                baseParts.push(part);
            }
        }

        return '/' + baseParts.join('/');
    }

    return {
        async *getargs(proc: Process): AsyncIterable<Response> {
            yield respond.ok(proc.args);
        },

        async *getcwd(proc: Process): AsyncIterable<Response> {
            yield respond.ok(proc.cwd);
        },

        async *chdir(proc: Process, path: unknown): AsyncIterable<Response> {
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            // Resolve path relative to cwd
            const resolvedPath = resolvePath(proc.cwd, path);

            // Verify path exists and is a directory
            try {
                const stat = await vfs.stat(resolvedPath, proc.id);
                if (stat.model !== 'folder') {
                    yield respond.error('ENOTDIR', `Not a directory: ${path}`);
                    return;
                }
            } catch (err) {
                // Path doesn't exist or access denied
                const code = (err as { code?: string }).code ?? 'ENOENT';
                const message = (err as Error).message ?? `No such directory: ${path}`;
                yield respond.error(code, message);
                return;
            }

            proc.cwd = resolvedPath;
            yield respond.ok();
        },

        async *getenv(proc: Process, name: unknown): AsyncIterable<Response> {
            if (typeof name !== 'string') {
                yield respond.error('EINVAL', 'name must be a string');
                return;
            }
            yield respond.ok(proc.env[name]);
        },

        async *setenv(proc: Process, name: unknown, value: unknown): AsyncIterable<Response> {
            if (typeof name !== 'string') {
                yield respond.error('EINVAL', 'name must be a string');
                return;
            }
            if (typeof value !== 'string') {
                yield respond.error('EINVAL', 'value must be a string');
                return;
            }
            proc.env[name] = value;
            yield respond.ok();
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
    _hal: HAL,
    connectTcp: (proc: Process, host: string, port: number) => Promise<number>,
    createPort: (proc: Process, type: string, opts: unknown) => Promise<number>,
    getPort: (proc: Process, portId: number) => import('./resource.js').Port | undefined,
    recvPort: (proc: Process, portId: number) => Promise<ProcessPortMessage>,
    closePort: (proc: Process, portId: number) => Promise<void>
): SyscallRegistry {
    return {
        async *connect(proc: Process, proto: unknown, host: unknown, port: unknown): AsyncIterable<Response> {
            if (typeof proto !== 'string') {
                yield respond.error('EINVAL', 'proto must be a string');
                return;
            }
            if (typeof host !== 'string') {
                yield respond.error('EINVAL', 'host must be a string');
                return;
            }

            switch (proto) {
                case 'tcp':
                    if (typeof port !== 'number') {
                        yield respond.error('EINVAL', 'port must be a number');
                        return;
                    }
                    yield respond.ok(await connectTcp(proc, host, port));
                    return;

                case 'unix':
                    // Unix sockets use path as host, port=0
                    yield respond.ok(await connectTcp(proc, host, 0));
                    return;

                default:
                    yield respond.error('EINVAL', `unsupported protocol: ${proto}`);
            }
        },

        async *port(proc: Process, type: unknown, opts: unknown): AsyncIterable<Response> {
            if (typeof type !== 'string') {
                yield respond.error('EINVAL', 'type must be a string');
                return;
            }

            const portId = await createPort(proc, type, opts);
            yield respond.ok(portId);
        },

        async *recv(proc: Process, portId: unknown): AsyncIterable<Response> {
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }

            const port = getPort(proc, portId);
            if (!port) {
                yield respond.error('EBADF', `Bad port: ${portId}`);
                return;
            }

            const msg = await recvPort(proc, portId);
            yield respond.ok(msg);
        },

        async *send(proc: Process, portId: unknown, to: unknown, data: unknown): AsyncIterable<Response> {
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }
            if (typeof to !== 'string') {
                yield respond.error('EINVAL', 'to must be a string');
                return;
            }
            if (!(data instanceof Uint8Array)) {
                yield respond.error('EINVAL', 'data must be Uint8Array');
                return;
            }

            const port = getPort(proc, portId);
            if (!port) {
                yield respond.error('EBADF', `Bad port: ${portId}`);
                return;
            }

            await port.send(to, data);
            yield respond.ok();
        },

        async *pclose(proc: Process, portId: unknown): AsyncIterable<Response> {
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }

            await closePort(proc, portId);
            yield respond.ok();
        },
    };
}

/**
 * Create channel syscalls.
 *
 * @param hal - HAL instance
 * @param openChannel - Function to open a channel and allocate channel id
 * @param getChannel - Function to get channel from channel id
 * @param closeChannel - Function to close channel
 */
export function createChannelSyscalls(
    _hal: HAL,
    openChannel: (proc: Process, proto: string, url: string, opts?: ChannelOpts) => Promise<number>,
    getChannel: (proc: Process, ch: number) => Channel | undefined,
    closeChannel: (proc: Process, ch: number) => Promise<void>
): SyscallRegistry {
    return {
        async *channel_open(proc: Process, proto: unknown, url: unknown, opts?: unknown): AsyncIterable<Response> {
            if (typeof proto !== 'string') {
                yield respond.error('EINVAL', 'proto must be a string');
                return;
            }
            if (typeof url !== 'string') {
                yield respond.error('EINVAL', 'url must be a string');
                return;
            }

            const ch = await openChannel(proc, proto, url, opts as ChannelOpts | undefined);
            yield respond.ok(ch);
        },

        async *channel_call(proc: Process, ch: unknown, msg: unknown): AsyncIterable<Response> {
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            // Yield until terminal response
            for await (const response of channel.handle(msg as Message)) {
                yield response;
                if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
                    return;
                }
            }
            yield respond.error('EIO', 'No response from channel');
        },

        async *channel_stream(proc: Process, ch: unknown, msg: unknown): AsyncIterable<Response> {
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            yield* channel.handle(msg as Message);
        },

        async *channel_push(proc: Process, ch: unknown, response: unknown): AsyncIterable<Response> {
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            await channel.push(response as Response);
            yield respond.ok();
        },

        async *channel_recv(proc: Process, ch: unknown): AsyncIterable<Response> {
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            const channel = getChannel(proc, ch);
            if (!channel) {
                yield respond.error('EBADF', `Bad channel: ${ch}`);
                return;
            }

            const msg = await channel.recv();
            yield respond.ok(msg);
        },

        async *channel_close(proc: Process, ch: unknown): AsyncIterable<Response> {
            if (typeof ch !== 'number') {
                yield respond.error('EINVAL', 'ch must be a number');
                return;
            }

            await closeChannel(proc, ch);
            yield respond.ok();
        },
    };
}
