/**
 * Listener Port
 *
 * TCP listener port wrapping HAL Listener.
 */

import type { Listener } from '@src/hal/index.js';
import type { PortType } from '@src/kernel/types.js';
import { ENOTSUP } from '@src/kernel/errors.js';
import type { Port, PortMessage } from './types.js';

/**
 * TCP listener port
 *
 * Wraps HAL Listener to provide port interface.
 * recv() accepts connections and returns them as PortMessages with socket.
 */
export class ListenerPort implements Port {
    readonly type: PortType = 'tcp:listen';
    private _closed = false;

    constructor(
        readonly id: string,
        private listener: Listener,
        readonly description: string
    ) {}

    get closed(): boolean {
        return this._closed;
    }

    async recv(): Promise<PortMessage> {
        const socket = await this.listener.accept();
        const stat = socket.stat();
        return {
            from: `${stat.remoteAddr}:${stat.remotePort}`,
            socket,
        };
    }

    async send(_to: string, _data?: Uint8Array, _meta?: Record<string, unknown>): Promise<void> {
        throw new ENOTSUP('tcp:listen ports do not support send');
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await this.listener.close();
    }

    /**
     * Get listener address
     */
    addr(): { hostname: string; port: number } {
        return this.listener.addr();
    }
}
