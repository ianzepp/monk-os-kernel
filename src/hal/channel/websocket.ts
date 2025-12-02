/**
 * WebSocket Channel
 *
 * WebSocket client channel for bidirectional communication.
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts } from './types.js';

/**
 * WebSocket client channel.
 */
export class BunWebSocketClientChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'websocket';
    readonly description: string;

    private ws: WebSocket | null = null;
    private _closed = false;
    private messageQueue: Message[] = [];
    private messageResolve: ((msg: Message) => void) | null = null;
    private responseQueue: Response[] = [];
    private responseResolve: ((resp: Response) => void) | null = null;

    constructor(url: string, _opts?: ChannelOpts) {
        this.description = url;
        this.connect(url);
    }

    private connect(url: string): void {
        // Convert ws:// or wss:// if needed
        const wsUrl = url.replace(/^http/, 'ws');
        this.ws = new WebSocket(wsUrl);

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // Check if it's a response or a message
                if (data.op && ['ok', 'error', 'item', 'chunk', 'event', 'progress', 'done'].includes(data.op)) {
                    // It's a response
                    if (this.responseResolve) {
                        this.responseResolve(data);
                        this.responseResolve = null;
                    } else {
                        this.responseQueue.push(data);
                    }
                } else {
                    // It's a message (from server)
                    if (this.messageResolve) {
                        this.messageResolve(data);
                        this.messageResolve = null;
                    } else {
                        this.messageQueue.push(data);
                    }
                }
            } catch {
                // Non-JSON message, treat as raw message
                const msg: Message = { op: 'raw', data: event.data };
                if (this.messageResolve) {
                    this.messageResolve(msg);
                    this.messageResolve = null;
                } else {
                    this.messageQueue.push(msg);
                }
            }
        };

        this.ws.onclose = () => {
            this._closed = true;
            // Reject any pending receives
            if (this.messageResolve) {
                this.messageResolve({ op: 'close', data: null });
                this.messageResolve = null;
            }
            if (this.responseResolve) {
                this.responseResolve(respond.error('ECONNRESET', 'Connection closed'));
                this.responseResolve = null;
            }
        };

        this.ws.onerror = () => {
            this._closed = true;
        };
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        // Send the message
        this.ws.send(JSON.stringify(msg));

        // Wait for response(s)
        while (true) {
            const response = await this.waitForResponse();
            yield response;

            if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
                break;
            }
        }
    }

    private async waitForResponse(): Promise<Response> {
        if (this.responseQueue.length > 0) {
            return this.responseQueue.shift()!;
        }

        return new Promise((resolve) => {
            this.responseResolve = resolve;
        });
    }

    async push(response: Response): Promise<void> {
        if (this._closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Channel closed');
        }
        this.ws.send(JSON.stringify(response));
    }

    async recv(): Promise<Message> {
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        if (this._closed) {
            return { op: 'close', data: null };
        }

        return new Promise((resolve) => {
            this.messageResolve = resolve;
        });
    }

    async close(): Promise<void> {
        this._closed = true;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}
