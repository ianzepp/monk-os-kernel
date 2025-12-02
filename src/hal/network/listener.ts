/**
 * Bun Listener
 *
 * TCP listener wrapper for Bun.listen().
 */

import type { Listener, ListenerAcceptOpts, ListenOpts, Socket } from './types.js';
import { BunSocket } from './socket.js';

/**
 * Bun TCP listener wrapper
 */
export class BunListener implements Listener {
    // Use 'any' to avoid Bun.listen's complex union type between TCP/Unix listeners
    private server: any = null;
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

    async accept(opts?: ListenerAcceptOpts): Promise<Socket> {
        if (this.closed) {
            throw new Error('Listener closed');
        }

        if (this.connectionQueue.length > 0) {
            return this.connectionQueue.shift()!;
        }

        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            if (opts?.timeout) {
                timeoutId = setTimeout(() => {
                    this.connectionResolve = null;
                    reject(new Error('ETIMEDOUT: Accept timeout'));
                }, opts.timeout);
            }

            this.connectionResolve = (socket) => {
                if (timeoutId) clearTimeout(timeoutId);
                resolve(socket);
            };
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
