/**
 * Watch Port
 *
 * VFS file system event watcher port.
 */

import type { PortType } from '@src/kernel/types.js';
import { EBADF, ENOTSUP } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

/**
 * Watch event from VFS (re-exported for kernel use)
 */
export type { WatchEvent as VfsWatchEvent } from '@src/vfs/model.js';
import type { WatchEvent } from '@src/vfs/model.js';

/**
 * Watch port
 *
 * Subscribes to VFS file system events and delivers them as port messages.
 * Pattern supports glob-style matching:
 * - `/users/*` - direct children of /users
 * - `/users/**` - all descendants of /users
 * - `/users/123` - exact path
 */
export class WatchPort implements Port {
    readonly type: PortType = 'watch';
    private _closed = false;
    private messageQueue: PortMessage[] = [];
    private waiters: Array<(msg: PortMessage) => void> = [];
    private vfsIterator: AsyncIterator<WatchEvent> | null = null;
    private iteratorDone = false;

    constructor(
        readonly id: string,
        private pattern: string,
        private vfsWatch: (pattern: string) => AsyncIterable<WatchEvent>,
        readonly description: string
    ) {
        // Start consuming VFS events in background
        this.startConsuming();
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Start consuming events from VFS and queuing/delivering them
     */
    private async startConsuming(): Promise<void> {
        try {
            const iterable = this.vfsWatch(this.pattern);
            this.vfsIterator = iterable[Symbol.asyncIterator]();

            while (!this._closed) {
                const result = await this.vfsIterator.next();
                if (result.done) {
                    this.iteratorDone = true;
                    break;
                }

                const event = result.value;
                const message: PortMessage = {
                    from: event.path,
                    data: new TextEncoder().encode(JSON.stringify({
                        entity: event.entity,
                        op: event.op,
                        fields: event.fields,
                    })),
                    meta: {
                        op: event.op,
                        entity: event.entity,
                        fields: event.fields,
                        timestamp: event.timestamp,
                    },
                };

                // If someone is waiting, deliver directly
                if (this.waiters.length > 0) {
                    const waiter = this.waiters.shift()!;
                    waiter(message);
                } else {
                    this.messageQueue.push(message);
                }
            }
        } catch (error) {
            // If closed, ignore errors
            if (!this._closed) {
                console.error('WatchPort error:', error);
            }
        }
    }

    async recv(): Promise<PortMessage> {
        if (this._closed) {
            throw new EBADF('Port closed');
        }

        // If we have queued messages, return one
        if (this.messageQueue.length > 0) {
            return this.messageQueue.shift()!;
        }

        // If iterator is done and no queued messages, throw
        if (this.iteratorDone) {
            throw new Error('EOF: No more events');
        }

        // Wait for next message
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async send(_to: string, _data: Uint8Array): Promise<void> {
        throw new ENOTSUP('watch ports do not support send');
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        // Clear waiters (they will receive nothing - port closed)
        this.waiters = [];
        this.messageQueue = [];
    }
}
