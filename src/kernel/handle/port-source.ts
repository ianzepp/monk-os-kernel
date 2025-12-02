/**
 * Port Source Adapter
 *
 * Wraps a Port (pubsub, watch, udp) and presents it as a readable Handle.
 * Each port message becomes a JSON line on read.
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Handle, HandleType } from './types.js';
import type { Port } from '@src/kernel/resource.js';

/**
 * Adapts a Port to a readable Handle interface.
 *
 * When the process reads, this blocks waiting for the next port message,
 * then returns it as a JSON line. This allows services to read from
 * pubsub/watch/udp sources using standard stdin reading patterns.
 */
export class PortSourceAdapter implements Handle {
    readonly type: HandleType = 'port-source';
    private _closed = false;

    constructor(
        readonly id: string,
        private port: Port,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;

        switch (op) {
            case 'read':
                yield* this.read();
                break;

            case 'write':
                yield respond.error('EBADF', 'Port source is read-only');
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *read(): AsyncIterable<Response> {
        try {
            // Block waiting for next port message
            const portMsg = await this.port.recv();

            // Convert to JSON line
            const line = JSON.stringify({
                from: portMsg.from,
                data: portMsg.data ? Array.from(portMsg.data) : undefined,
                meta: portMsg.meta,
            }) + '\n';

            const data = new TextEncoder().encode(line);
            yield respond.chunk(data);
            yield respond.done();
        } catch (err) {
            if (this._closed) {
                // EOF on closed port
                yield respond.done();
            } else {
                yield respond.error('EIO', (err as Error).message);
            }
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.port.close();
    }
}
