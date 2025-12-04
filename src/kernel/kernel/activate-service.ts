/**
 * Activate a service based on its definition.
 *
 * @module kernel/kernel/activate-service
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import type { WatchEvent } from '../../vfs/model.js';
import { ListenerPort, PubsubPort, WatchPort, UdpPort } from '../resource.js';
import { spawnServiceHandler } from './spawn-service-handler.js';
import { runActivationLoop } from './run-activation-loop.js';
import { publishPubsub } from './publish-pubsub.js';
import { printk } from './printk.js';

/**
 * Activate a service based on its definition.
 *
 * @param self - Kernel instance
 * @param name - Service name
 * @param def - Service definition
 */
export async function activateService(
    self: Kernel,
    name: string,
    def: ServiceDef
): Promise<void> {
    const activation = def.activate;

    switch (activation.type) {
        case 'boot':
            await spawnServiceHandler(self, name, def);
            break;

        case 'tcp:listen': {
            const hostname = activation.host ?? '127.0.0.1';
            const listener = await self.hal.network.listen(activation.port, { hostname });

            const portId = self.hal.entropy.uuid();
            const addr = listener.addr();
            const description = `service:${name}:tcp:${addr.hostname}:${addr.port}`;
            const port = new ListenerPort(portId, listener, description);

            self.activationPorts.set(name, port);

            const abort = new AbortController();
            self.activationAborts.set(name, abort);

            runActivationLoop(self, name, def, port, abort.signal, (msg) => {
                if (msg.socket) {
                    const stat = msg.socket.stat();
                    printk(self, 'tcp', `${name}: accepted from ${stat.remoteAddr}:${stat.remotePort}`);
                    return {
                        socket: msg.socket,
                        activation: {
                            op: 'tcp',
                            data: {
                                remoteAddr: stat.remoteAddr,
                                remotePort: stat.remotePort,
                                localAddr: stat.localAddr,
                                localPort: stat.localPort,
                            },
                        },
                    };
                }
                return null;
            });
            break;
        }

        case 'pubsub': {
            const portId = self.hal.entropy.uuid();
            const patterns = [activation.topic];
            const description = `service:${name}:pubsub:${activation.topic}`;

            const publishFn = (topic: string, data: Uint8Array | undefined, meta: Record<string, unknown> | undefined, sourcePortId: string) => {
                publishPubsub(self, topic, data, meta, sourcePortId);
            };
            const unsubscribeFn = () => {
                self.pubsubPorts.delete(port);
            };

            const port = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
            self.pubsubPorts.add(port);
            self.activationPorts.set(name, port);

            const abort = new AbortController();
            self.activationAborts.set(name, abort);

            runActivationLoop(self, name, def, port, abort.signal, (msg) => ({
                activation: {
                    op: 'pubsub',
                    data: { topic: msg.from, payload: msg.data },
                },
            }));
            break;
        }

        case 'watch': {
            const portId = self.hal.entropy.uuid();
            const description = `service:${name}:watch:${activation.pattern}`;

            const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                return self.vfs.watch(pattern, 'kernel');
            };

            const port = new WatchPort(portId, activation.pattern, vfsWatch, description);
            self.activationPorts.set(name, port);

            const abort = new AbortController();
            self.activationAborts.set(name, abort);

            runActivationLoop(self, name, def, port, abort.signal, (msg) => ({
                activation: {
                    op: 'watch',
                    data: { path: msg.from, event: msg.meta?.op, content: msg.data },
                },
            }));
            break;
        }

        case 'udp': {
            const portId = self.hal.entropy.uuid();
            const description = `service:${name}:udp:${activation.host ?? '0.0.0.0'}:${activation.port}`;

            const port = new UdpPort(portId, { bind: activation.port, address: activation.host }, description);
            self.activationPorts.set(name, port);

            const abort = new AbortController();
            self.activationAborts.set(name, abort);

            runActivationLoop(self, name, def, port, abort.signal, (msg) => ({
                activation: {
                    op: 'udp',
                    data: { from: msg.from, payload: msg.data },
                },
            }));
            break;
        }
    }
}
