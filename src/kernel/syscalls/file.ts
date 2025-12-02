/**
 * File Syscalls
 *
 * File operation syscalls (open, close, read, write, etc.)
 */

import type { VFS } from '@src/vfs/index.js';
import type { HAL } from '@src/hal/index.js';
import type { Process, OpenFlags } from '@src/kernel/types.js';
import { MAX_STREAM_ENTRIES } from '@src/kernel/types.js';
import type { Handle } from '@src/kernel/handle.js';
import type { Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry } from './types.js';

/**
 * Create file operation syscalls.
 *
 * @param vfs - VFS instance
 * @param hal - HAL instance
 * @param getHandle - Function to get handle from fd
 * @param openFile - Function to open a file and allocate fd
 * @param closeHandle - Function to close fd
 */
export function createFileSyscalls(
    vfs: VFS,
    _hal: HAL,
    getHandle: (proc: Process, fd: number) => Handle | undefined,
    openFile: (proc: Process, path: string, flags: OpenFlags) => Promise<number>,
    closeHandle: (proc: Process, fd: number) => Promise<void>
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
            await closeHandle(proc, fd);
            yield respond.ok();
        },

        async *read(proc: Process, fd: unknown, chunkSize?: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            // Delegate to handle's recv implementation
            yield* handle.exec({ op: 'recv', data: { chunkSize } });
        },

        async *write(proc: Process, fd: unknown, data: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            // Delegate to handle's send implementation
            yield* handle.exec({ op: 'send', data: { data } });
        },

        async *seek(proc: Process, fd: unknown, offset: unknown, whence: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            // Only file handles support seek
            if (handle.type !== 'file') {
                yield respond.error('EINVAL', 'Illegal seek on socket');
                return;
            }

            // Delegate to handle's seek implementation
            yield* handle.exec({ op: 'seek', data: { offset, whence: whence ?? 'start' } });
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

            const handle = getHandle(proc, fd);
            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            // Only file handles have path-based stat
            if (handle.type !== 'file') {
                yield respond.error('EINVAL', 'fstat not supported on sockets');
                return;
            }

            const statResult = await vfs.stat(handle.description, proc.id);
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

        /**
         * Receive messages from fd (message-based I/O).
         * Used for fd 0/1/2 (recv/send/warn) which are MessagePipe handles.
         */
        async *recv(proc: Process, fd: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            yield* handle.exec({ op: 'recv' });
        },

        /**
         * Send a message to fd (message-based I/O).
         * Used for fd 0/1/2 (recv/send/warn) which are MessagePipe handles.
         */
        async *send(proc: Process, fd: unknown, msg: unknown): AsyncIterable<Response> {
            if (typeof fd !== 'number') {
                yield respond.error('EINVAL', 'fd must be a number');
                return;
            }

            const handle = getHandle(proc, fd);
            if (!handle) {
                yield respond.error('EBADF', `Bad file descriptor: ${fd}`);
                return;
            }

            yield* handle.exec({ op: 'send', data: msg as Response });
        },
    };
}
