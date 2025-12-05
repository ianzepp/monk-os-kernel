/**
 * Pipe operations for VFS scripts.
 *
 * Message-based I/O for fd 0/1/2 (recv/send/warn).
 */

import type { Response } from './types';
import { syscall, call } from './syscall';
import { SyscallError } from './error';

/**
 * Create a pipe pair [recvFd, sendFd].
 */
export function pipe(): Promise<[number, number]> {
    return call<[number, number]>('ipc:pipe');
}

/**
 * Redirect a file descriptor.
 */
export async function redirect(targetFd: number, sourceFd: number): Promise<() => Promise<void>> {
    const saved = await call<string>('handle:redirect', { target: targetFd, source: sourceFd });

    return async () => {
        await call('handle:restore', { target: targetFd, saved });
    };
}

/**
 * Receive messages from fd (typically fd 0).
 * Yields Response objects until done/error.
 */
export async function* recv(fd: number = 0): AsyncIterable<Response> {
    for await (const response of syscall('file:recv', fd)) {
        if (response.op === 'done') {
            return;
        }

        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };

            throw new SyscallError(err.code, err.message);
        }

        yield response;
    }
}

/**
 * Send a message to fd (typically fd 1).
 */
export async function send(fd: number, msg: Response): Promise<void> {
    await call('file:send', fd, msg);
}
