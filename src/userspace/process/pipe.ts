/**
 * Pipe Operations - MESSAGE-BASED Inter-Process Communication
 *
 * THIS IS NOT UNIX. Pipes in Monk OS carry structured Response messages,
 * NOT raw bytes. This is the fundamental I/O mechanism for process communication.
 *
 * MESSAGE I/O (this module):
 * - recv(fd) → AsyncIterable<Response>  (receive messages)
 * - send(fd, msg) → Promise<void>       (send message)
 * - pipe() → [recvFd, sendFd]           (create message pipe pair)
 *
 * Standard file descriptors:
 * - fd 0: recv() - receive Response messages from parent/pipe
 * - fd 1: send() - send Response messages to parent/pipe
 * - fd 2: warn() - diagnostic messages (also Response-based)
 *
 * Response message format:
 * ```typescript
 * interface Response {
 *     op: 'ok' | 'error' | 'item' | 'data' | 'done' | ...;
 *     data?: unknown;    // Structured data
 *     bytes?: Uint8Array; // Binary payload (for 'data' op)
 * }
 * ```
 *
 * For BYTE I/O (files, sockets), use read()/write() from file.ts.
 * For byte-stream helpers, use ByteReader/ByteWriter from io.ts.
 *
 * @module rom/lib/process/pipe
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
