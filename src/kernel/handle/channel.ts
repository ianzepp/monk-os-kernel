/**
 * Channel Handle Adapter
 *
 * Wraps HAL Channel in the unified handle interface.
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel } from '@src/hal/channel.js';
import type { Handle, HandleType } from './types.js';

/**
 * Channel handle wrapping HAL Channel.
 *
 * Channels already have handle(msg) → AsyncIterable<Response>, so this
 * adapter is thin - it just delegates to the channel.
 *
 * Supported ops:
 * - call: Send message, receive single response
 * - stream: Send message, receive streaming response
 * - push: Push response (server-side)
 * - recv: Receive message (bidirectional)
 */
export class ChannelHandleAdapter implements Handle {
    readonly type: HandleType = 'channel';
    private _closed = false;

    constructor(
        readonly id: string,
        private channel: Channel,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed || this.channel.closed;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'call':
                // Send inner message, take first response
                for await (const response of this.channel.handle(data?.msg as Message)) {
                    yield response;
                    if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
                        return;
                    }
                }
                yield respond.error('EIO', 'No response from channel');
                break;

            case 'stream':
                // Send inner message, yield all responses
                yield* this.channel.handle(data?.msg as Message);
                break;

            case 'push':
                // Push response (server-side)
                try {
                    await this.channel.push(data?.response as Response);
                    yield respond.ok();
                } catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }
                break;

            case 'recv':
                // Receive message (bidirectional)
                try {
                    const recvMsg = await this.channel.recv();
                    yield respond.ok(recvMsg);
                } catch (err) {
                    yield respond.error('EIO', (err as Error).message);
                }
                break;

            default:
                // Forward other ops directly to channel
                yield* this.channel.handle(msg);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.channel.close();
    }

    /**
     * Get underlying channel (for kernel-internal operations)
     */
    getChannel(): Channel {
        return this.channel;
    }

    /**
     * Get channel protocol
     */
    getProto(): string {
        return this.channel.proto;
    }
}
