/**
 * Channel Device
 *
 * Protocol-aware bidirectional message exchange over persistent connections.
 * Channels are the third I/O primitive in Monk OS, alongside file descriptors
 * (Resources) and Ports.
 *
 * Supported protocols:
 * - http/https: HTTP client using fetch()
 * - sse: Server-Sent Events (server push)
 * - websocket: WebSocket bidirectional
 * - postgres: PostgreSQL via Bun.sql (future)
 *
 * Bun touchpoints:
 * - fetch() for HTTP/HTTPS
 * - Bun.serve() for SSE/WebSocket server-side
 * - Bun.sql() for database protocols (future)
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Socket } from './network.js';

/**
 * Channel options
 */
export interface ChannelOpts {
    /** Default headers (HTTP) */
    headers?: Record<string, string>;
    /** Keep connection alive */
    keepAlive?: boolean;
    /** Request timeout in ms */
    timeout?: number;
    /** Database name (postgres) */
    database?: string;
}

/**
 * Channel interface for protocol-aware message passing.
 *
 * Channels wrap protocol-specific connections and provide a unified
 * message-based interface for request/response and streaming patterns.
 */
export interface Channel {
    /** Unique channel ID */
    readonly id: string;

    /** Protocol type */
    readonly proto: string;

    /** Description (URL or connection info) */
    readonly description: string;

    /**
     * Handle a message (internal).
     * Both call() and stream() use this; call() takes first response.
     *
     * @param msg - Message to handle
     * @returns Async iterable of responses
     */
    handle(msg: Message): AsyncIterable<Response>;

    /**
     * Push a response to remote (server-side).
     *
     * @param response - Response to push
     */
    push(response: Response): Promise<void>;

    /**
     * Receive a message from remote (bidirectional).
     *
     * @returns Message from remote
     */
    recv(): Promise<Message>;

    /**
     * Close the channel.
     */
    close(): Promise<void>;

    /** Whether the channel is closed */
    readonly closed: boolean;
}

/**
 * Channel device interface.
 *
 * The HAL provides channel creation for both client and server sides.
 */
export interface ChannelDevice {
    /**
     * Open a channel as client.
     *
     * @param proto - Protocol type (http, https, websocket, postgres, etc.)
     * @param url - Connection URL
     * @param opts - Channel options
     * @returns Channel instance
     */
    open(proto: string, url: string, opts?: ChannelOpts): Promise<Channel>;

    /**
     * Wrap an accepted socket as server-side channel.
     *
     * @param socket - Accepted socket from listener
     * @param proto - Protocol type (sse, websocket)
     * @param opts - Channel options
     * @returns Channel instance
     */
    accept(socket: Socket, proto: string, opts?: ChannelOpts): Promise<Channel>;
}

/**
 * HTTP request data
 */
interface HttpRequest {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    accept?: string;
}

/**
 * Bun channel device implementation.
 */
export class BunChannelDevice implements ChannelDevice {
    async open(proto: string, url: string, opts?: ChannelOpts): Promise<Channel> {
        switch (proto) {
            case 'http':
            case 'https':
                return new BunHttpChannel(url, opts);

            case 'websocket':
            case 'ws':
            case 'wss':
                return new BunWebSocketClientChannel(url, opts);

            case 'postgres':
            case 'postgresql':
                return new BunPostgresChannel(url, opts);

            default:
                throw new Error(`Unsupported protocol: ${proto}`);
        }
    }

    async accept(socket: Socket, proto: string, opts?: ChannelOpts): Promise<Channel> {
        switch (proto) {
            case 'sse':
                return new BunSSEServerChannel(socket, opts);

            case 'websocket':
                // WebSocket server-side requires the upgrade to have happened
                // This is typically handled by the HTTP server
                throw new Error('WebSocket server channels should be created via HTTP upgrade');

            default:
                throw new Error(`Unsupported server protocol: ${proto}`);
        }
    }
}

/**
 * HTTP client channel using fetch().
 */
class BunHttpChannel implements Channel {
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

/**
 * WebSocket client channel.
 */
class BunWebSocketClientChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'websocket';
    readonly description: string;

    private ws: WebSocket | null = null;
    private _closed = false;
    private messageQueue: Message[] = [];
    private messageResolve: ((msg: Message) => void) | null = null;
    private responseQueue: Response[] = [];
    private responseResolve: ((resp: Response) => void) | null = null;

    constructor(url: string, private opts?: ChannelOpts) {
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

/**
 * SSE server channel (server pushes to client).
 */
class BunSSEServerChannel implements Channel {
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

/**
 * PostgreSQL channel (placeholder for future Bun.sql integration).
 */
class BunPostgresChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'postgres';
    readonly description: string;

    private _closed = false;

    constructor(url: string, _opts?: ChannelOpts) {
        this.description = url;
        // TODO: Initialize Bun.sql connection when available
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        // Placeholder implementation
        // TODO: Implement actual PostgreSQL queries via Bun.sql
        switch (msg.op) {
            case 'query': {
                yield respond.error('ENOSYS', 'PostgreSQL support not yet implemented');
                break;
            }

            case 'execute': {
                yield respond.error('ENOSYS', 'PostgreSQL support not yet implemented');
                break;
            }

            default:
                yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('PostgreSQL channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('PostgreSQL channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
        // TODO: Close Bun.sql connection
    }
}
