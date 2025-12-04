/**
 * Create handle from IO source config.
 *
 * @module kernel/kernel/create-io-source-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { IOSource } from '../services.js';
import type { Handle } from '../handle.js';
import type { WatchEvent } from '../../vfs/model.js';
import { respond } from '../../message.js';
import { FileHandleAdapter, PortHandleAdapter } from '../handle.js';
import { PubsubPort, WatchPort, UdpPort } from '../resource.js';
import { publishPubsub } from './publish-pubsub.js';

/**
 * Path to the console device in VFS.
 */
const CONSOLE_PATH = '/dev/console';

/**
 * Create handle from IO source config.
 *
 * @param self - Kernel instance
 * @param source - IO source configuration
 * @param proc - Process
 * @returns Handle
 */
export async function createIOSourceHandle(
    self: Kernel,
    source: IOSource,
    proc: Process
): Promise<Handle> {
    switch (source.type) {
        case 'console': {
            const vfsHandle = await self.vfs.open(CONSOLE_PATH, { read: true }, 'kernel');
            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }
        case 'file': {
            const vfsHandle = await self.vfs.open(source.path, { read: true }, 'kernel');
            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }
        case 'null': {
            return {
                id: self.hal.entropy.uuid(),
                type: 'file' as const,
                description: '/dev/null',
                closed: false,
                async *exec() { yield respond.done(); },
                async close() {},
            };
        }
        case 'pubsub:subscribe': {
            const patterns = Array.isArray(source.topics)
                ? source.topics
                : [source.topics];
            const portId = self.hal.entropy.uuid();
            const description = `pubsub:subscribe:${patterns.join(',')}`;

            const publishFn = (topic: string, data: Uint8Array | undefined, meta: Record<string, unknown> | undefined, sourcePortId: string) => {
                publishPubsub(self, topic, data, meta, sourcePortId);
            };
            const unsubscribeFn = () => {
                self.pubsubPorts.delete(port);
            };

            const port = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
            self.pubsubPorts.add(port);

            return new PortHandleAdapter(portId, port, description);
        }
        case 'fs:watch': {
            const portId = self.hal.entropy.uuid();
            const description = `fs:watch:${source.pattern}`;

            const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                return self.vfs.watch(pattern, proc.id);
            };

            const port = new WatchPort(portId, source.pattern, vfsWatch, description);
            return new PortHandleAdapter(portId, port, description);
        }
        case 'udp:bind': {
            const portId = self.hal.entropy.uuid();
            const description = `udp:bind:${source.host ?? '0.0.0.0'}:${source.port}`;
            const port = new UdpPort(portId, { bind: source.port, address: source.host }, description);
            return new PortHandleAdapter(portId, port, description);
        }
    }
}
