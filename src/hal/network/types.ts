/**
 * Network Types
 *
 * Shared types and interfaces for network implementations.
 */

/**
 * TLS configuration
 */
export interface TlsOpts {
    /** Private key (PEM string or file path) */
    key: string;
    /** Certificate (PEM string or file path) */
    cert: string;
    /** CA certificates for client verification (optional) */
    ca?: string;
}

/**
 * Listen options
 */
export interface ListenOpts {
    /** Hostname to bind to (default: 0.0.0.0) */
    hostname?: string;
    /** Enable TLS */
    tls?: TlsOpts;
    /** Connection backlog (default: OS default, typically 128) */
    backlog?: number;
}

/**
 * Connect options
 */
export interface ConnectOpts {
    /** Connection timeout in ms */
    timeout?: number;
    /** Enable TLS */
    tls?: boolean;
    /** Server name for SNI (defaults to host) */
    servername?: string;
}

/**
 * Socket metadata
 */
export interface SocketStat {
    remoteAddr: string;
    remotePort: number;
    localAddr: string;
    localPort: number;
}

/**
 * Socket read options
 */
export interface SocketReadOpts {
    /** Read timeout in milliseconds. If exceeded, throws ETIMEDOUT. */
    timeout?: number;
}

/**
 * Socket interface for connected TCP connections.
 *
 * Provides a read()-based interface over Bun's event-driven sockets.
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using socket = await network.connect('localhost', 8080);
 * await socket.write(data);
 * // auto-closed on scope exit
 * ```
 */
export interface Socket extends AsyncDisposable {
    /**
     * Read available data.
     * Blocks until data arrives, connection closes, or timeout.
     *
     * Bun: Data is buffered from socket 'data' events
     *
     * @param opts - Read options (timeout)
     * @returns Data bytes, or empty array if connection closed
     * @throws ETIMEDOUT if timeout exceeded
     */
    read(opts?: SocketReadOpts): Promise<Uint8Array>;

    /**
     * Write data to socket.
     *
     * Bun: socket.write() - may buffer if kernel buffer full
     *
     * Caveat: Bun's socket.write() returns number of bytes written.
     * If less than data.length, the rest is buffered. This method
     * blocks until all data is written or queued.
     */
    write(data: Uint8Array): Promise<void>;

    /**
     * Close socket.
     *
     * Bun: socket.end() for graceful close
     */
    close(): Promise<void>;

    /**
     * Socket metadata.
     */
    stat(): SocketStat;
}

/**
 * Listener accept options
 */
export interface ListenerAcceptOpts {
    /** Accept timeout in milliseconds. If exceeded, throws ETIMEDOUT. */
    timeout?: number;
}

/**
 * Listener interface for TCP servers.
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using listener = await network.listen(8080);
 * const socket = await listener.accept();
 * // listener auto-closed on scope exit
 * ```
 */
export interface Listener extends AsyncDisposable {
    /**
     * Accept next incoming connection.
     * Blocks until a connection arrives or timeout.
     *
     * Bun: Connections buffered from 'open' events
     *
     * @param opts - Accept options (timeout)
     * @throws ETIMEDOUT if timeout exceeded
     */
    accept(opts?: ListenerAcceptOpts): Promise<Socket>;

    /**
     * Stop listening and close all connections.
     *
     * Bun: server.stop()
     */
    close(): Promise<void>;

    /**
     * Local address.
     */
    addr(): { hostname: string; port: number };
}

/**
 * HTTP handler function
 */
export type HttpHandler = (req: Request) => Response | Promise<Response>;

/**
 * HTTP server interface
 *
 * Implements AsyncDisposable for use with `await using`:
 * ```typescript
 * await using server = await network.serve(8080, handler);
 * // server auto-closed on scope exit
 * ```
 */
export interface HttpServer extends AsyncDisposable {
    /**
     * Stop server.
     *
     * Bun: server.stop()
     */
    close(): Promise<void>;

    /**
     * Server address.
     */
    addr(): { hostname: string; port: number };
}

/**
 * Network device interface.
 */
export interface NetworkDevice {
    /**
     * Create a TCP listener.
     *
     * Bun: Bun.listen() with socket handlers
     *
     * @param port - Port to listen on
     * @param opts - Listen options
     * @returns Listener handle
     */
    listen(port: number, opts?: ListenOpts): Promise<Listener>;

    /**
     * Connect to a TCP server or Unix socket.
     *
     * Bun: Bun.connect({ hostname, port }) or Bun.connect({ unix: path })
     *
     * @param host - Hostname/IP for TCP, or socket path for Unix
     * @param port - Port number for TCP, or 0 for Unix sockets
     * @param opts - Connection options
     * @returns Connected socket
     */
    connect(host: string, port: number, opts?: ConnectOpts): Promise<Socket>;

    /**
     * Create an HTTP server.
     *
     * Bun: Bun.serve()
     *
     * @param port - Port to listen on
     * @param handler - Request handler
     * @returns Server handle
     */
    serve(port: number, handler: HttpHandler): Promise<HttpServer>;
}
