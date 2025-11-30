/**
 * Network Device
 *
 * TCP/UDP sockets and HTTP server.
 * Processes access the network through this interface.
 *
 * Bun touchpoints:
 * - Bun.listen() for TCP/UDP servers
 * - Bun.connect() for TCP clients
 * - Bun.serve() for HTTP servers
 *
 * Caveats:
 * - Bun.listen() socket API is event-driven, not read()-based
 *   This HAL wraps it to provide a read() interface via buffering
 * - UDP is supported via Bun.listen with type: 'udp' but not exposed here yet
 * - TLS requires key/cert paths or strings, not CryptoKey objects
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
     * Blocks until data arrives or connection closes.
     *
     * Bun: Data is buffered from socket 'data' events
     *
     * @returns Data bytes, or empty array if connection closed
     */
    read(): Promise<Uint8Array>;

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
     * Blocks until a connection arrives.
     *
     * Bun: Connections buffered from 'open' events
     */
    accept(): Promise<Socket>;

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
     * Connect to a TCP server.
     *
     * Bun: Bun.connect()
     *
     * @param host - Hostname or IP
     * @param port - Port number
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

/**
 * Bun network device implementation
 *
 * Bun touchpoints:
 * - Bun.listen({ port, socket: {...} }) for TCP
 * - Bun.connect({ hostname, port, socket: {...} }) for client
 * - Bun.serve({ port, fetch }) for HTTP
 *
 * Caveats:
 * - Bun sockets are event-driven; we buffer data for read() interface
 * - accept() and read() return Promises that resolve when data available
 * - No UDP support in this interface (could be added)
 */
export class BunNetworkDevice implements NetworkDevice {
    async listen(port: number, opts?: ListenOpts): Promise<Listener> {
        return new BunListener(port, opts);
    }

    async connect(host: string, port: number, opts?: ConnectOpts): Promise<Socket> {
        return new Promise((resolve, reject) => {
            const dataQueue: Uint8Array[] = [];
            let dataResolve: ((data: Uint8Array) => void) | null = null;
            let closed = false;
            let socketRef: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never;

            const socket = Bun.connect({
                hostname: host,
                port,
                tls: opts?.tls,

                socket: {
                    open(socket) {
                        socketRef = socket as any;
                        resolve(new BunSocket(socket as any, dataQueue, () => dataResolve, (r) => { dataResolve = r; }, () => closed, (c) => { closed = c; }));
                    },
                    data(socket, data) {
                        const bytes = new Uint8Array(data);
                        if (dataResolve) {
                            dataResolve(bytes);
                            dataResolve = null;
                        } else {
                            dataQueue.push(bytes);
                        }
                    },
                    close() {
                        closed = true;
                        if (dataResolve) {
                            dataResolve(new Uint8Array(0));
                            dataResolve = null;
                        }
                    },
                    error(socket, error) {
                        closed = true;
                        reject(error);
                    },
                    connectError(socket, error) {
                        reject(error);
                    },
                },
            });

            if (opts?.timeout) {
                setTimeout(() => {
                    if (!socketRef) {
                        reject(new Error('Connection timeout'));
                    }
                }, opts.timeout);
            }
        });
    }

    async serve(port: number, handler: HttpHandler): Promise<HttpServer> {
        const server = Bun.serve({
            port,
            fetch: handler,
        });

        return {
            async close() {
                server.stop();
            },
            async [Symbol.asyncDispose]() {
                server.stop();
            },
            addr() {
                return {
                    hostname: server.hostname,
                    port: server.port,
                };
            },
        };
    }
}

/**
 * Bun TCP listener wrapper
 */
class BunListener implements Listener {
    private server: ReturnType<typeof Bun.listen> | null = null;
    private connectionQueue: Socket[] = [];
    private connectionResolve: ((socket: Socket) => void) | null = null;
    private closed = false;
    private hostname: string;
    private port: number;

    constructor(port: number, opts?: ListenOpts) {
        this.port = port;
        this.hostname = opts?.hostname ?? '0.0.0.0';
        this.start(opts);
    }

    private start(opts?: ListenOpts): void {
        const self = this;

        this.server = Bun.listen({
            hostname: this.hostname,
            port: this.port,
            tls: opts?.tls ? {
                key: Bun.file(opts.tls.key),
                cert: Bun.file(opts.tls.cert),
            } : undefined,

            socket: {
                open(socket) {
                    const dataQueue: Uint8Array[] = [];
                    let dataResolve: ((data: Uint8Array) => void) | null = null;
                    let closed = false;

                    const wrappedSocket = new BunSocket(
                        socket,
                        dataQueue,
                        () => dataResolve,
                        (r) => { dataResolve = r; },
                        () => closed,
                        (c) => { closed = c; }
                    );

                    // Store reference for data/close handlers
                    (socket as any)._halSocket = wrappedSocket;
                    (socket as any)._dataQueue = dataQueue;
                    (socket as any)._getDataResolve = () => dataResolve;
                    (socket as any)._setDataResolve = (r: any) => { dataResolve = r; };
                    (socket as any)._setClosed = (c: boolean) => { closed = c; };

                    if (self.connectionResolve) {
                        self.connectionResolve(wrappedSocket);
                        self.connectionResolve = null;
                    } else {
                        self.connectionQueue.push(wrappedSocket);
                    }
                },
                data(socket, data) {
                    const bytes = new Uint8Array(data);
                    const dataQueue = (socket as any)._dataQueue as Uint8Array[];
                    const dataResolve = (socket as any)._getDataResolve() as ((data: Uint8Array) => void) | null;

                    if (dataResolve) {
                        dataResolve(bytes);
                        (socket as any)._setDataResolve(null);
                    } else {
                        dataQueue.push(bytes);
                    }
                },
                close(socket) {
                    (socket as any)._setClosed(true);
                    const dataResolve = (socket as any)._getDataResolve() as ((data: Uint8Array) => void) | null;
                    if (dataResolve) {
                        dataResolve(new Uint8Array(0));
                        (socket as any)._setDataResolve(null);
                    }
                },
                error(socket, error) {
                    console.error('Socket error:', error);
                    (socket as any)._setClosed(true);
                },
            },
        });
    }

    async accept(): Promise<Socket> {
        if (this.closed) {
            throw new Error('Listener closed');
        }

        if (this.connectionQueue.length > 0) {
            return this.connectionQueue.shift()!;
        }

        return new Promise((resolve) => {
            this.connectionResolve = resolve;
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.server) {
            this.server.stop();
            this.server = null;
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    addr(): { hostname: string; port: number } {
        return {
            hostname: this.hostname,
            port: this.port,
        };
    }
}

/**
 * Bun socket wrapper providing read() interface
 */
class BunSocket implements Socket {
    constructor(
        private socket: any, // Bun socket type
        private dataQueue: Uint8Array[],
        private getDataResolve: () => ((data: Uint8Array) => void) | null,
        private setDataResolve: (r: ((data: Uint8Array) => void) | null) => void,
        private isClosed: () => boolean,
        private setClosed: (c: boolean) => void
    ) {}

    async read(): Promise<Uint8Array> {
        if (this.dataQueue.length > 0) {
            return this.dataQueue.shift()!;
        }

        if (this.isClosed()) {
            return new Uint8Array(0);
        }

        return new Promise((resolve) => {
            this.setDataResolve(resolve);
        });
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.isClosed()) {
            throw new Error('Socket closed');
        }

        const written = this.socket.write(data);
        if (written < data.length) {
            // Data was buffered; Bun will drain it
            // For now, we don't wait for drain - Bun handles backpressure
        }
    }

    async close(): Promise<void> {
        this.setClosed(true);
        this.socket.end();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    stat(): SocketStat {
        return {
            remoteAddr: this.socket.remoteAddress ?? 'unknown',
            remotePort: this.socket.remotePort ?? 0,
            localAddr: this.socket.localAddress ?? 'unknown',
            localPort: this.socket.localPort ?? 0,
        };
    }
}
