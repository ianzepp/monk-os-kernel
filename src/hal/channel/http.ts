/**
 * HTTP Channel
 *
 * HTTP client channel using fetch().
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts, HttpRequest } from './types.js';

/**
 * HTTP client channel using fetch().
 */
export class BunHttpChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'http';
    readonly description: string;

    private baseUrl: string;
    private defaultHeaders: Record<string, string>;
    private timeout?: number;
    private _closed = false;

    constructor(url: string, opts?: ChannelOpts) {
        this.baseUrl = url;
        this.description = url;
        this.defaultHeaders = opts?.headers ?? {};
        this.timeout = opts?.timeout;
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        if (msg.op !== 'request') {
            yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            return;
        }

        const req = msg.data as HttpRequest;
        const url = this.buildUrl(req.path, req.query);

        try {
            const controller = new AbortController();
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            if (this.timeout) {
                timeoutId = setTimeout(() => controller.abort(), this.timeout);
            }

            const response = await fetch(url, {
                method: req.method || 'GET',
                headers: { ...this.defaultHeaders, ...req.headers },
                body: req.body ? JSON.stringify(req.body) : undefined,
                signal: controller.signal,
            });

            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                yield respond.error(`HTTP_${response.status}`, response.statusText);
                return;
            }

            // Check for streaming response
            const contentType = response.headers.get('content-type') || '';
            if (req.accept === 'application/jsonl' || contentType.includes('application/jsonl')) {
                // Stream JSONL
                if (response.body) {
                    for await (const line of this.readLines(response.body)) {
                        if (line.trim()) {
                            try {
                                yield respond.item(JSON.parse(line));
                            } catch {
                                // Skip malformed lines
                            }
                        }
                    }
                }
                yield respond.done();
            } else if (contentType.includes('text/event-stream')) {
                // Stream SSE
                if (response.body) {
                    for await (const event of this.readSSE(response.body)) {
                        yield respond.event(event.type, event.data);
                    }
                }
                yield respond.done();
            } else {
                // Single JSON response
                const data = await response.json();
                yield respond.ok(data);
            }
        } catch (err) {
            const error = err as Error;
            if (error.name === 'AbortError') {
                yield respond.error('ETIMEDOUT', 'Request timeout');
            } else {
                yield respond.error('EIO', error.message);
            }
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('HTTP client channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('HTTP client channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
        // Connection pooling handled by fetch
    }

    private buildUrl(path: string, query?: Record<string, unknown>): string {
        const url = new URL(path, this.baseUrl);
        if (query) {
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        return url.toString();
    }

    private async *readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop()!;

                for (const line of lines) {
                    yield line;
                }
            }

            if (buffer.trim()) {
                yield buffer;
            }
        } finally {
            reader.releaseLock();
        }
    }

    private async *readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<{ type: string; data: Record<string, unknown> }> {
        let eventType = 'message';
        let dataBuffer = '';

        for await (const line of this.readLines(body)) {
            if (line === '') {
                // Empty line = end of event
                if (dataBuffer) {
                    try {
                        yield { type: eventType, data: JSON.parse(dataBuffer) };
                    } catch {
                        yield { type: eventType, data: { raw: dataBuffer } };
                    }
                    dataBuffer = '';
                    eventType = 'message';
                }
            } else if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataBuffer += line.slice(5).trim();
            }
        }
    }
}
