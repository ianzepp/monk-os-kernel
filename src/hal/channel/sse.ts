/**
 * SSE Channel
 *
 * Server-Sent Events server channel (server pushes to client).
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Socket } from '../network/types.js';
import type { Channel, ChannelOpts } from './types.js';

/**
 * SSE server channel (server pushes to client).
 */
export class BunSSEServerChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'sse';
    readonly description = 'sse:server';

    private socket: Socket;
    private encoder = new TextEncoder();
    private _closed = false;
    private headersSent = false;

    constructor(socket: Socket, _opts?: ChannelOpts) {
        this.socket = socket;
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(_msg: Message): AsyncIterable<Response> {
        // SSE server channels don't handle incoming messages this way
        yield respond.error('EINVAL', 'Use push() for SSE server channels');
    }

    async push(response: Response): Promise<void> {
        if (this._closed) {
            throw new Error('Channel closed');
        }

        // Send headers on first push
        if (!this.headersSent) {
            const headers = [
                'HTTP/1.1 200 OK',
                'Content-Type: text/event-stream',
                'Cache-Control: no-cache',
                'Connection: keep-alive',
                '',
                '',
            ].join('\r\n');
            await this.socket.write(this.encoder.encode(headers));
            this.headersSent = true;
        }

        // Format as SSE event
        let eventData: string;
        if (response.op === 'event') {
            const eventPayload = response.data as { type: string; [key: string]: unknown };
            eventData = `event: ${eventPayload.type}\ndata: ${JSON.stringify(response.data)}\n\n`;
        } else {
            eventData = `data: ${JSON.stringify(response.data)}\n\n`;
        }

        await this.socket.write(this.encoder.encode(eventData));
    }

    async recv(): Promise<Message> {
        throw new Error('SSE server channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
        await this.socket.close();
    }
}
