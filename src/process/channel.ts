/**
 * Channel Library
 *
 * Userland interface for protocol-aware bidirectional message exchange.
 * Channels provide message-based communication over persistent connections
 * with protocol-level framing handled by the HAL.
 *
 * Usage:
 *   import { channel } from '@src/process/channel';
 *
 *   const ch = await channel.open('http', 'https://api.example.com');
 *   const response = await channel.call(ch, { op: 'request', data: { method: 'GET', path: '/users' } });
 *   await channel.close(ch);
 */

import { syscall } from '@src/process/syscall.js';
import { withTypedErrors } from '@src/process/errors.js';
import type { Message, Response } from '@src/message.js';

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
 * Channel API namespace.
 *
 * Provides protocol-aware message passing over persistent connections.
 */
export const channel = {
    /**
     * Open a channel to a remote service.
     *
     * @param proto - Protocol type (http, https, websocket, postgres, etc.)
     * @param url - Connection URL
     * @param opts - Channel options
     * @returns Channel ID
     *
     * @example
     * const api = await channel.open('http', 'https://api.example.com', {
     *     headers: { 'Authorization': 'Bearer token' },
     *     timeout: 30000
     * });
     */
    async open(proto: string, url: string, opts?: ChannelOpts): Promise<number> {
        return withTypedErrors(syscall<number>('channel_open', proto, url, opts));
    },

    /**
     * Send a request and receive a single response.
     *
     * Waits for the first response from the channel (ok or error).
     * Use this for request/response patterns like HTTP or database queries.
     *
     * @param ch - Channel ID
     * @param msg - Message to send
     * @returns Response
     *
     * @example
     * const response = await channel.call(ch, {
     *     op: 'request',
     *     data: { method: 'GET', path: '/users' }
     * });
     * if (response.op === 'ok') {
     *     console.log(response.data);
     * }
     */
    async call<T = unknown>(ch: number, msg: Message): Promise<Response & { data?: T }> {
        return withTypedErrors(syscall<Response & { data?: T }>('channel_call', ch, msg));
    },

    /**
     * Send a request and iterate streaming responses.
     *
     * Returns an async iterable that yields responses until 'done' or 'error'.
     * Use this for streaming patterns like JSONL, SSE, or database cursors.
     *
     * @param ch - Channel ID
     * @param msg - Message to send
     * @returns Async iterable of responses
     *
     * @example
     * for await (const response of channel.stream(ch, {
     *     op: 'query',
     *     data: { sql: 'SELECT * FROM users', cursor: true }
     * })) {
     *     if (response.op === 'item') {
     *         console.log(response.data);
     *     }
     * }
     */
    async *stream(ch: number, msg: Message): AsyncIterable<Response> {
        // Note: This requires kernel support for streaming syscalls
        // For now, we use channel_call in a loop pattern
        // TODO: Implement proper streaming when kernel supports AsyncIterable syscalls
        const result = await withTypedErrors(syscall<Response[]>('channel_stream', ch, msg));
        if (Array.isArray(result)) {
            for (const response of result) {
                yield response;
            }
        }
    },

    /**
     * Push a response to the remote (server-side channels).
     *
     * Used for SSE and WebSocket server channels to send data to clients.
     *
     * @param ch - Channel ID
     * @param response - Response to push
     *
     * @example
     * await channel.push(sseChannel, {
     *     op: 'event',
     *     data: { type: 'update', payload: { ... } }
     * });
     */
    async push(ch: number, response: Response): Promise<void> {
        return withTypedErrors(syscall<void>('channel_push', ch, response));
    },

    /**
     * Receive a message from the remote (bidirectional channels).
     *
     * Used for WebSocket channels to receive messages from clients.
     * Blocks until a message is available.
     *
     * @param ch - Channel ID
     * @returns Message from remote
     *
     * @example
     * while (true) {
     *     const msg = await channel.recv(wsChannel);
     *     if (msg.op === 'close') break;
     *     await handleMessage(msg);
     * }
     */
    async recv(ch: number): Promise<Message> {
        return withTypedErrors(syscall<Message>('channel_recv', ch));
    },

    /**
     * Close a channel.
     *
     * @param ch - Channel ID
     *
     * @example
     * await channel.close(ch);
     */
    async close(ch: number): Promise<void> {
        return withTypedErrors(syscall<void>('channel_close', ch));
    },
};

/**
 * HTTP request helper.
 *
 * Convenience type for HTTP channel requests.
 */
export interface HttpRequest {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    accept?: string;
}

/**
 * Create an HTTP request message.
 *
 * @param request - HTTP request parameters
 * @returns Message for channel.call()
 */
export function httpRequest(request: HttpRequest): Message {
    return { op: 'request', data: request };
}

/**
 * Create a SQL query message.
 *
 * @param sql - SQL query string
 * @param params - Query parameters
 * @param cursor - Whether to use cursor for streaming
 * @returns Message for channel.call() or channel.stream()
 */
export function sqlQuery(sql: string, params?: unknown[], cursor?: boolean): Message {
    return { op: 'query', data: { sql, params, cursor } };
}

/**
 * Create a SQL execute message (DDL, no results).
 *
 * @param sql - SQL statement
 * @returns Message for channel.call()
 */
export function sqlExecute(sql: string): Message {
    return { op: 'execute', data: { sql } };
}
