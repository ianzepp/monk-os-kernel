/**
 * Channel Syscalls
 *
 * Channel operation syscalls (channel_open, channel_call, channel_stream, etc.)
 */

import type { HAL, Channel, ChannelOpts } from '@src/hal/index.js';
import type { Process } from '@src/kernel/types.js';
import type { Response, Message } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry } from './types.js';

/**
 * Create channel syscalls.
 *
 * @param hal - HAL instance
 * @param openChannel - Function to open a channel and allocate handle
 * @param getChannel - Function to get channel from handle
 * @param closeHandle - Function to close handle
 */
export function createChannelSyscalls(
    _hal: HAL,
    openChannel: (proc: Process, proto: string, url: string, opts?: ChannelOpts) => Promise<number>,
    getChannel: (proc: Process, ch: number) => Channel | undefined,
    closeHandle: (proc: Process, ch: number) => Promise<void>
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

            await closeHandle(proc, ch);
            yield respond.ok();
        },
    };
}
