/**
 * Create a port and allocate handle.
 *
 * @module kernel/kernel/create-port
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Port } from '../resource.js';
import type { WatchEvent } from '../../vfs/model.js';
import { EINVAL } from '../errors.js';
import { ListenerPort, WatchPort, UdpPort, PubsubPort } from '../resource.js';
import { PortHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';
import { publishPubsub } from './publish-pubsub.js';

/**
 * Create a port and allocate handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param type - Port type
 * @param opts - Port options
 * @returns File descriptor number
 */
export async function createPort(
    self: Kernel,
    proc: Process,
    type: string,
    opts: unknown
): Promise<number> {
    let port: Port;

    switch (type) {
        case 'tcp:listen': {
            const listenOpts = opts as { port: number; host?: string; backlog?: number } | undefined;
            if (!listenOpts || typeof listenOpts.port !== 'number') {
                throw new EINVAL('tcp:listen requires port option');
            }

            const listener = await self.hal.network.listen(listenOpts.port, {
                hostname: listenOpts.host,
                backlog: listenOpts.backlog,
            });

            const portId = self.hal.entropy.uuid();
            const addr = listener.addr();
            const description = `tcp:listen:${addr.hostname}:${addr.port}`;
            port = new ListenerPort(portId, listener, description);
            break;
        }

        case 'fs:watch': {
            const watchOpts = opts as { pattern: string } | undefined;
            if (!watchOpts || typeof watchOpts.pattern !== 'string') {
                throw new EINVAL('fs:watch requires pattern option');
            }

            const portId = self.hal.entropy.uuid();
            const description = `fs:watch:${watchOpts.pattern}`;

            const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                return self.vfs.watch(pattern, proc.id);
            };

            port = new WatchPort(portId, watchOpts.pattern, vfsWatch, description);
            break;
        }

        case 'udp:bind': {
            const udpOpts = opts as { port: number; host?: string } | undefined;
            if (!udpOpts || typeof udpOpts.port !== 'number') {
                throw new EINVAL('udp:bind requires port option');
            }

            const portId = self.hal.entropy.uuid();
            const description = `udp:bind:${udpOpts.host ?? '0.0.0.0'}:${udpOpts.port}`;
            port = new UdpPort(portId, { bind: udpOpts.port, address: udpOpts.host }, description);
            break;
        }

        case 'pubsub:subscribe': {
            const pubsubOpts = opts as { topics?: string | string[] } | undefined;
            const patterns = pubsubOpts?.topics
                ? Array.isArray(pubsubOpts.topics)
                    ? pubsubOpts.topics
                    : [pubsubOpts.topics]
                : [];

            const portId = self.hal.entropy.uuid();
            const description = patterns.length > 0
                ? `pubsub:subscribe:${patterns.join(',')}`
                : 'pubsub:subscribe:(send-only)';

            const publishFn = (topic: string, data: Uint8Array | undefined, meta: Record<string, unknown> | undefined, sourcePortId: string) => {
                publishPubsub(self, topic, data, meta, sourcePortId);
            };

            const unsubscribeFn = () => {
                const handle = self.handles.get(portId) as PortHandleAdapter | undefined;
                if (handle) {
                    const p = handle.getPort() as PubsubPort;
                    self.pubsubPorts.delete(p);
                }
            };

            const pubsubPort = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
            self.pubsubPorts.add(pubsubPort);
            port = pubsubPort;
            break;
        }

        default:
            throw new EINVAL(`Unknown port type: ${type}`);
    }

    const adapter = new PortHandleAdapter(port.id, port, port.description);
    return allocHandle(self, proc, adapter);
}
