/**
 * Socket Handle Adapter
 *
 * Wraps HAL Socket in the unified handle interface.
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Socket } from '@src/hal/network.js';
import { DEFAULT_CHUNK_SIZE, MAX_STREAM_BYTES } from '@src/kernel/types.js';
import type { Handle, HandleType } from './types.js';

/**
 * Socket handle wrapping HAL Socket.
 *
 * Supported ops:
 * - recv: Stream chunks until EOF
 * - send: Write data
 * - stat: Get socket metadata
 */
export class SocketHandleAdapter implements Handle {
    readonly type: HandleType = 'socket';
    private _closed = false;
    private buffer: Uint8Array = new Uint8Array(0);
    private readonly _stat: { remoteAddr: string; remotePort: number; localAddr: string; localPort: number };

    constructor(
        readonly id: string,
        private socket: Socket,
        readonly description: string
    ) {
        // Cache stat on construction
        this._stat = socket.stat();
    }

    get closed(): boolean {
        return this._closed;
    }

    async *exec(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'recv':
                yield* this.recv(data?.chunkSize as number | undefined);
                break;

            case 'send':
                yield* this.send(data?.data as Uint8Array);
                break;

            case 'stat':
                yield respond.ok(this._stat);
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *recv(chunkSize?: number): AsyncIterable<Response> {
        const size = chunkSize ?? DEFAULT_CHUNK_SIZE;
        let totalYielded = 0;

        try {
            while (true) {
                const chunk = await this.readChunk(size);

                // EOF
                if (chunk.length === 0) {
                    break;
                }

                totalYielded += chunk.length;
                if (totalYielded > MAX_STREAM_BYTES) {
                    yield respond.error('EFBIG', `Read stream exceeded ${MAX_STREAM_BYTES} bytes`);
                    return;
                }

                yield respond.data(chunk);
            }

            yield respond.done();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async readChunk(size: number): Promise<Uint8Array> {
        // If we have buffered data, return from buffer first
        if (this.buffer.length > 0) {
            if (size >= this.buffer.length) {
                const data = this.buffer;
                this.buffer = new Uint8Array(0);
                return data;
            }
            const data = this.buffer.slice(0, size);
            this.buffer = this.buffer.slice(size);
            return data;
        }

        // Read from socket
        const chunk = await this.socket.read();
        if (chunk.length === 0) {
            return chunk; // EOF
        }

        // If chunk fits, return it
        if (chunk.length <= size) {
            return chunk;
        }

        // Return requested size, buffer the rest
        this.buffer = chunk.slice(size);
        return chunk.slice(0, size);
    }

    private async *send(data: Uint8Array): AsyncIterable<Response> {
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            await this.socket.write(data);
            yield respond.ok({ written: data.length });
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.socket.close();
    }

    /**
     * Get underlying socket (for kernel-internal operations)
     */
    getSocket(): Socket {
        return this.socket;
    }

    /**
     * Get cached socket metadata
     */
    stat(): { remoteAddr: string; remotePort: number; localAddr: string; localPort: number } {
        return this._stat;
    }
}
