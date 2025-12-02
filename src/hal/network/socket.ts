/**
 * Bun Socket
 *
 * Socket wrapper providing read() interface over Bun's event-driven sockets.
 */

import { ETIMEDOUT, EBADF } from '../errors.js';
import type { Socket, SocketReadOpts, SocketStat } from './types.js';

/**
 * Bun socket wrapper providing read() interface
 */
export class BunSocket implements Socket {
    constructor(
        private socket: any, // Bun socket type
        private dataQueue: Uint8Array[],
        _getDataResolve: () => ((data: Uint8Array) => void) | null,
        private setDataResolve: (r: ((data: Uint8Array) => void) | null) => void,
        private isClosed: () => boolean,
        private setClosed: (c: boolean) => void
    ) {}

    async read(opts?: SocketReadOpts): Promise<Uint8Array> {
        if (this.dataQueue.length > 0) {
            return this.dataQueue.shift()!;
        }

        if (this.isClosed()) {
            return new Uint8Array(0);
        }

        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            if (opts?.timeout) {
                timeoutId = setTimeout(() => {
                    this.setDataResolve(null);
                    reject(new ETIMEDOUT('Read timeout'));
                }, opts.timeout);
            }

            this.setDataResolve((data) => {
                if (timeoutId) clearTimeout(timeoutId);
                resolve(data);
            });
        });
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.isClosed()) {
            throw new EBADF('Socket closed');
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
