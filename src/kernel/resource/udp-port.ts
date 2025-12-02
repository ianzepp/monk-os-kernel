/**
 * UDP Port
 *
 * UDP datagram send/receive port.
 */

import type { PortType } from '@src/kernel/types.js';
import { EBADF, EINVAL } from '@src/kernel/errors.js';
import type { Port, PortMessage, UdpSocketOpts } from './types.js';

/**
 * Bun UDP socket interface
 *
 * Typed interface for Bun.udpSocket() return value.
 * When Bun's types stabilize, mismatches will surface as compile errors.
 */
interface BunUdpSocket {
    /** Send datagram to remote host:port */
    send(data: Uint8Array, port: number, host: string): number;
    /** Close the socket */
    close(): void;
}

/**
 * UDP port
 *
 * Send and receive UDP datagrams.
 * Each recv() returns a message with the sender's address in `from`.
 * send() requires a destination address in "host:port" format.
 */
export class UdpPort implements Port {
    readonly type: PortType = 'udp';
    private _closed = false;
    private messageQueue: PortMessage[] = [];
    private waiters: Array<(msg: PortMessage) => void> = [];
    private socket: BunUdpSocket | null = null;

    constructor(
        readonly id: string,
        private opts: UdpSocketOpts,
        readonly description: string
    ) {
        this.startListening();
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Start listening for UDP datagrams
     */
    private startListening(): void {
        const self = this;

        this.socket = Bun.udpSocket({
            port: this.opts.bind,
            hostname: this.opts.address ?? '0.0.0.0',

            socket: {
                data(_socket, buf, port, addr) {
                    const message: PortMessage = {
                        from: `${addr}:${port}`,
                        data: new Uint8Array(buf),
                    };

                    if (self.waiters.length > 0) {
                        const waiter = self.waiters.shift()!;
                        waiter(message);
                    } else {
                        self.messageQueue.push(message);
                    }
                },
                error(_socket, error) {
                    console.error('UDP socket error:', error);
                },
            },
        }) as unknown as BunUdpSocket;
    }

    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // If we have queued messages, return one
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        // Wait for next message
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async send(to: string, data: Uint8Array): Promise<void> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // Parse "host:port" format
        const lastColon = to.lastIndexOf(':');
        if (lastColon === -1) {
            throw new EINVAL('Invalid address format, expected host:port');
        }

        const host = to.slice(0, lastColon);
        const port = parseInt(to.slice(lastColon + 1), 10);

        if (isNaN(port)) {
            throw new EINVAL('Invalid port number');
        }

        if (!this.socket) {
            throw new EBADF('Socket not initialized');
        }
        this.socket.send(data, port, host);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        this.waiters = [];
        this.messageQueue = [];
    }
}
