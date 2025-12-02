/**
 * Channel Device
 *
 * Bun channel device implementation for opening and accepting channels.
 */

import type { Socket } from '../network/types.js';
import type { Channel, ChannelDevice, ChannelOpts } from './types.js';
import { BunHttpChannel } from './http.js';
import { BunWebSocketClientChannel } from './websocket.js';
import { BunSSEServerChannel } from './sse.js';
import { BunPostgresChannel } from './postgres.js';
import { BunSqliteChannel } from './sqlite.js';

/**
 * Bun channel device implementation.
 */
export class BunChannelDevice implements ChannelDevice {
    async open(proto: string, url: string, opts?: ChannelOpts): Promise<Channel> {
        switch (proto) {
            case 'http':
            case 'https':
                return new BunHttpChannel(url, opts);

            case 'websocket':
            case 'ws':
            case 'wss':
                return new BunWebSocketClientChannel(url, opts);

            case 'postgres':
            case 'postgresql':
                return new BunPostgresChannel(url, opts);

            case 'sqlite':
                return new BunSqliteChannel(url, opts);

            default:
                throw new Error(`Unsupported protocol: ${proto}`);
        }
    }

    async accept(socket: Socket, proto: string, opts?: ChannelOpts): Promise<Channel> {
        switch (proto) {
            case 'sse':
                return new BunSSEServerChannel(socket, opts);

            case 'websocket':
                // WebSocket server-side requires the upgrade to have happened
                // This is typically handled by the HTTP server
                throw new Error('WebSocket server channels should be created via HTTP upgrade');

            default:
                throw new Error(`Unsupported server protocol: ${proto}`);
        }
    }
}
