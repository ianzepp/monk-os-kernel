/**
 * Channel operations for VFS scripts.
 * Protocol-aware message passing API.
 */

import { ChannelOpts, HttpRequest, Message, Response } from './types';
import { SyscallError } from './error';
import { call, syscall } from './syscall';

/**
 * Channel API for protocol-aware message passing.
 */
export const channel = {
    /**
     * Open a channel to a remote service.
     */
    open(proto: string, url: string, opts?: ChannelOpts): Promise<number> {
        return call<number>('channel_open', proto, url, opts);
    },

    /**
     * Send a request and receive a single response.
     * Handles streaming under the hood (progress, events, etc).
     */
    async call<T = unknown>(ch: number, msg: Message): Promise<Response & { data?: T }> {
        for await (const response of syscall('channel_call', ch, msg)) {
            // Pass through progress/events but keep waiting for terminal
            if (response.op === 'ok' || response.op === 'error' || response.op === 'done' || response.op === 'redirect') {
                return response as Response & { data?: T };
            }
        }
        throw new SyscallError('EIO', 'No response from channel');
    },

    /**
     * Send a request and iterate streaming responses.
     */
    stream(ch: number, msg: Message): AsyncIterable<Response> {
        return syscall('channel_stream', ch, msg);
    },

    /**
     * Push a response to the remote (server-side channels).
     */
    push(ch: number, response: Response): Promise<void> {
        return call<void>('channel_push', ch, response);
    },

    /**
     * Receive a message from the remote (bidirectional channels).
     */
    recv(ch: number): Promise<Message> {
        return call<Message>('channel_recv', ch);
    },

    /**
     * Close a channel.
     */
    close(ch: number): Promise<void> {
        return call<void>('channel_close', ch);
    },
};

/**
 * Create an HTTP request message.
 */
export function httpRequest(request: HttpRequest): Message {
    return { op: 'request', data: request };
}

/**
 * Create a SQL query message.
 */
export function sqlQuery(sql: string, params?: unknown[], cursor?: boolean): Message {
    return { op: 'query', data: { sql, params, cursor } };
}

/**
 * Create a SQL execute message.
 */
export function sqlExecute(sql: string): Message {
    return { op: 'execute', data: { sql } };
}
