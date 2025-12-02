/**
 * API Framework Types
 *
 * Core types for the jsond API server.
 */

import type { Message, Response } from '@src/message';

/**
 * User identity attached to an authenticated connection.
 */
export interface User {
    id: string;
    tenant: string;
    [key: string]: unknown;
}

/**
 * A client connection to the jsond server.
 */
export interface Connection {
    /** Unique connection ID */
    id: string;

    /** Authenticated user (set by auth handler) */
    user?: User;

    /** Send a response to this connection */
    send(response: Response): Promise<void>;

    /** Close the connection */
    close(): Promise<void>;

    /** Connection metadata */
    meta: Record<string, unknown>;
}

/**
 * Context passed to op handlers.
 */
export interface OpContext {
    /** The connection this message came from */
    conn: Connection;

    /** The message being processed */
    msg: Message;

    /** Parameters extracted from op pattern (e.g., "data:*" captures the wildcard) */
    params: Record<string, string>;

    /** System context (set by tenant middleware) */
    system?: unknown;

    /** Arbitrary context data (set by middleware) */
    [key: string]: unknown;
}

/**
 * An op handler function.
 * Returns an async iterable of responses (generator function).
 */
export type OpHandler = (ctx: OpContext) => AsyncIterable<Response>;

/**
 * Middleware function.
 * Can modify context, short-circuit with responses, or call next().
 */
export type Middleware = (
    ctx: OpContext,
    next: () => AsyncIterable<Response>
) => AsyncIterable<Response>;

/**
 * Route definition returned by api.op().
 */
export interface OpRoute {
    /** Add middleware to this route */
    middleware(...mw: Middleware[]): OpRoute;

    /** Set handler directly */
    handler(fn: OpHandler): OpRoute;

    /** Load handler from file path */
    pipe(path: string): OpRoute;
}

/**
 * Server listen options.
 */
export interface ListenOptions {
    /** TCP port for server-to-server / CLI connections */
    tcp?: number;

    /** WebSocket port for browser connections */
    ws?: number;

    /** Host to bind to (default: 0.0.0.0) */
    host?: string;
}

/**
 * The API server interface.
 */
export interface ApiServer {
    /** Scan directory for op handlers */
    scan(dir: string): Promise<void>;

    /** Apply middleware to op pattern */
    use(pattern: string, ...middleware: Middleware[]): void;

    /** Define or override a specific op */
    op(pattern: string): OpRoute;

    /** Start listening */
    listen(opts: ListenOptions): Promise<void>;

    /** Stop the server */
    close(): Promise<void>;
}
