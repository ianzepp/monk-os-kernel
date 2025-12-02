/**
 * Bun Network Device
 *
 * Network device implementation using Bun's networking APIs.
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

import { ETIMEDOUT } from '../errors.js';
import type { ConnectOpts, HttpHandler, HttpServer, Listener, ListenOpts, NetworkDevice, Socket } from './types.js';
import { BunSocket } from './socket.js';
import { BunListener } from './listener.js';

/**
 * Bun network device implementation
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

            const socketHandlers = {
                open(socket: any) {
                    socketRef = socket;
                    resolve(new BunSocket(socket, dataQueue, () => dataResolve, (r) => { dataResolve = r; }, () => closed, (c) => { closed = c; }));
                },
                data(_socket: any, data: any) {
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
                error(_socket: any, error: Error) {
                    closed = true;
                    reject(error);
                },
                connectError(_socket: any, error: Error) {
                    reject(error);
                },
            };

            // Unix socket if port is 0, TCP otherwise
            if (port === 0) {
                Bun.connect({
                    unix: host,
                    socket: socketHandlers,
                });
            } else {
                Bun.connect({
                    hostname: host,
                    port,
                    tls: opts?.tls,
                    socket: socketHandlers,
                });
            }

            if (opts?.timeout) {
                setTimeout(() => {
                    if (!socketRef) {
                        reject(new ETIMEDOUT('Connection timeout'));
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
                    hostname: server.hostname ?? '0.0.0.0',
                    port: server.port ?? 0,
                };
            },
        };
    }
}
