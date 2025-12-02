/**
 * Port Handle Adapter
 *
 * Wraps Port (listeners, watchers, pubsub) in the unified handle interface.
 */

import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Port } from '@src/kernel/resource.js';
import type { Handle, HandleType } from './types.js';

/**
 * Port handle wrapping Port (listeners, watchers, pubsub).
 *
 * Supported ops:
 * - recv: Receive next message (blocks until available)
 * - send: Send message to destination (pubsub, UDP)
 * - stat: Get port info
 *
 * Note: For tcp:listen ports, recv returns socket info, and the kernel
 * needs to wrap the socket into a new handle for the caller.
 */
export class PortHandleAdapter implements Handle {
    readonly type: HandleType = 'port';
    private _closed = false;

    constructor(
        readonly id: string,
        private port: Port,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed || this.port.closed;
    }

    async *send(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Handle closed');
            return;
        }

        const op = msg.op;
        const data = msg.data as Record<string, unknown> | undefined;

        switch (op) {
            case 'recv':
                yield* this.recv();
                break;

            case 'send':
                yield* this.portSend(
                    data?.to as string,
                    data?.data as Uint8Array
                );
                break;

            case 'stat':
                yield respond.ok({
                    type: this.port.type,
                    description: this.description,
                });
                break;

            default:
                yield respond.error('EINVAL', `Unknown op: ${op}`);
        }
    }

    private async *recv(): AsyncIterable<Response> {
        try {
            const msg = await this.port.recv();
            yield respond.ok(msg);
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    private async *portSend(to: string, data: Uint8Array): AsyncIterable<Response> {
        if (typeof to !== 'string') {
            yield respond.error('EINVAL', 'to must be a string');
            return;
        }
        if (!(data instanceof Uint8Array)) {
            yield respond.error('EINVAL', 'data must be Uint8Array');
            return;
        }

        try {
            await this.port.send(to, data);
            yield respond.ok();
        } catch (err) {
            yield respond.error('EIO', (err as Error).message);
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.port.close();
    }

    /**
     * Get underlying port (for kernel-internal operations like socket allocation)
     */
    getPort(): Port {
        return this.port;
    }

    /**
     * Get port type
     */
    getPortType(): string {
        return this.port.type;
    }
}
