/**
 * Channel Types
 *
 * Shared types and interfaces for channel implementations.
 */

import type { Message, Response } from '@src/message.js';
import type { Socket } from '../network/types.js';

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
    /** Open read-only (SQLite) */
    readonly?: boolean;
    /** Create file if missing (SQLite, default: true) */
    create?: boolean;
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
export interface HttpRequest {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    accept?: string;
}

/**
 * Query data for database channels.
 */
export interface QueryData {
    sql: string;
    params?: unknown[];
}
