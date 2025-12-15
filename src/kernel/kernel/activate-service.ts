/**
 * Service Activation - Socket activation and lifecycle management
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements service activation based on different triggers:
 * - boot: Start service immediately at kernel boot
 * - manual: Registered but not started (start via os.service('start', name))
 * - tcp:listen: Socket activation - spawn handler per connection
 * - pubsub:subscribe: Topic activation - spawn handler per message
 * - fs:watch: File watch activation - spawn handler per event
 * - udp:bind: UDP activation - spawn handler per datagram
 *
 * Each activation type creates a Port (listener/watcher/subscriber) and
 * runs an activation loop that spawns service handlers when events arrive.
 * The Port and abort controller are stored in kernel state for cleanup
 * on service stop.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every non-boot activation has exactly one Port in activationPorts
 *        VIOLATED BY: Creating multiple Ports for same service
 * INV-2: Every non-boot activation has exactly one AbortController in activationAborts
 *        VIOLATED BY: Not storing abort controller on activation
 * INV-3: Boot services spawn exactly once, socket services spawn per connection
 *        VIOLATED BY: Running activation loop for boot services
 * INV-4: Ports are cleaned up on service deactivation
 *        VIOLATED BY: Not removing from activationPorts on stop
 * INV-5: Socket from listener is passed to handler or closed
 *        VIOLATED BY: Leaking socket if spawn fails
 *
 * CONCURRENCY MODEL
 * =================
 * - Multiple activations can run concurrently (different services)
 * - Each activation loop runs in its own async context
 * - Ports handle their own internal synchronization
 * - Service handlers are spawned concurrently (not serialized)
 * - AbortController allows stopping activation loop from outside
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * postMessage crosses thread boundaries. The kernel runs in the main thread
 * while each process runs in its own worker thread.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Service stopped while accepting connection
 *       MITIGATION: AbortController cancels activation loop, socket closed in loop
 * RC-2: Handler spawn fails after accepting socket
 *       MITIGATION: Socket closed in error handler (runActivationLoop)
 * RC-3: Port cleanup fails on deactivation
 *       MITIGATION: Port close errors logged but don't block deactivation
 *
 * MEMORY MANAGEMENT
 * =================
 * - Port created per activation, stored in activationPorts
 * - AbortController created per activation, stored in activationAborts
 * - Socket lifecycle: accepted -> passed to handler OR closed on error
 * - Cleanup: Port.close() on deactivation, abort controller signals loop to exit
 *
 * TESTABILITY
 * ===========
 * - Activation types dispatched via switch (can mock ServiceDef)
 * - Ports injected via HAL (can mock network/vfs)
 * - AbortController allows external cancellation for testing
 *
 * @module kernel/kernel/activate-service
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import type { WatchEvent } from '../../vfs/model.js';
import { ListenerPort, PubsubPort, WatchPort, UdpPort } from '../resource.js';
import { spawnServiceHandler } from './spawn-service-handler.js';
import { runActivationLoop } from './run-activation-loop.js';
import { printk } from './printk.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Activate a service based on its definition.
 *
 * ALGORITHM:
 * 1. Dispatch on activation type (boot, tcp:listen, pubsub, fs:watch, udp)
 * 2. For boot: spawn handler once immediately
 * 3. For socket activations:
 *    a. Create Port (listener/watcher/subscriber)
 *    b. Store Port and AbortController in kernel state
 *    c. Start activation loop (spawns handler per event)
 *
 * @param self - Kernel instance
 * @param name - Service name
 * @param def - Service definition with activation config
 */
export async function activateService(
    self: Kernel,
    name: string,
    def: ServiceDef,
): Promise<void> {
    const activation = def.activate;

    switch (activation.type) {
        // =====================================================================
        // BOOT ACTIVATION
        // =====================================================================

        case 'boot':
            // WHY: Boot services spawn once at startup, no activation loop needed
            await spawnServiceHandler(self, name, def);
            break;

            // =====================================================================
            // MANUAL ACTIVATION (no-op at boot)
            // =====================================================================

        case 'manual':
            // WHY: Manual services are registered but not started at boot.
            // They can be started later via os.service('start', name).
            break;

            // =====================================================================
            // TCP SOCKET ACTIVATION
            // =====================================================================

        case 'tcp:listen': {
            // WHY: Listen on specified port/host, spawn handler per connection
            const hostname = activation.host ?? '127.0.0.1';
            const listener = await self.hal.network.listen(activation.port, { hostname });

            const portId = self.hal.entropy.uuid();
            const addr = listener.addr();
            const description = `service:${name}:tcp:${addr.hostname}:${addr.port}`;
            const port = new ListenerPort(portId, listener, description);

            // Store for cleanup on service stop
            self.activationPorts.set(name, port);

            const abort = new AbortController();

            self.activationAborts.set(name, abort);

            // Start activation loop (spawns handler per connection)
            // WHY: Transform extracts socket and builds activation message
            runActivationLoop(self, name, def, port, abort.signal, msg => {
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

        // =====================================================================
        // PUBSUB ACTIVATION
        // =====================================================================

        case 'pubsub:subscribe': {
            // WHY: Subscribe to topic pattern, spawn handler per message
            const portId = self.hal.entropy.uuid();
            const patterns = [activation.topic];
            const description = `service:${name}:pubsub:subscribe:${activation.topic}`;

            // Create port with HAL reference for redis pub/sub
            const port = new PubsubPort(portId, self.hal, patterns, description);

            // Initialize subscription (creates HAL subscription)
            await port.init();

            // Store for cleanup on service stop
            self.activationPorts.set(name, port);

            const abort = new AbortController();

            self.activationAborts.set(name, abort);

            // Start activation loop (spawns handler per message)
            runActivationLoop(self, name, def, port, abort.signal, msg => ({
                activation: {
                    op: 'pubsub:subscribe',
                    data: { topic: msg.from, payload: msg.data },
                },
            }));
            break;
        }

        // =====================================================================
        // FILESYSTEM WATCH ACTIVATION
        // =====================================================================

        case 'fs:watch': {
            // WHY: Watch file pattern, spawn handler per event (create/update/delete)
            const portId = self.hal.entropy.uuid();
            const description = `service:${name}:fs:watch:${activation.pattern}`;

            // WHY: VFS watch function provides file events via AsyncIterable
            const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                return self.vfs.watch(pattern, 'kernel');
            };

            const port = new WatchPort(portId, activation.pattern, vfsWatch, description);

            // Store for cleanup on service stop
            self.activationPorts.set(name, port);

            const abort = new AbortController();

            self.activationAborts.set(name, abort);

            // Start activation loop (spawns handler per event)
            runActivationLoop(self, name, def, port, abort.signal, msg => ({
                activation: {
                    op: 'fs:watch',
                    data: { path: msg.from, event: msg.meta?.op, content: msg.data },
                },
            }));
            break;
        }

        // =====================================================================
        // UDP ACTIVATION
        // =====================================================================

        case 'udp:bind': {
            // WHY: Bind UDP socket, spawn handler per datagram
            const portId = self.hal.entropy.uuid();
            const description = `service:${name}:udp:bind:${activation.host ?? '0.0.0.0'}:${activation.port}`;

            const port = new UdpPort(portId, { port: activation.port, host: activation.host }, description);

            // Store for cleanup on service stop
            self.activationPorts.set(name, port);

            const abort = new AbortController();

            self.activationAborts.set(name, abort);

            // Start activation loop (spawns handler per datagram)
            runActivationLoop(self, name, def, port, abort.signal, msg => ({
                activation: {
                    op: 'udp:bind',
                    data: { from: msg.from, payload: msg.data },
                },
            }));
            break;
        }
    }
}
