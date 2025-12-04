/**
 * Spawn a service handler process.
 *
 * @module kernel/kernel/spawn-service-handler
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import type { Socket } from '../../hal/network.js';
import type { Message } from '../../message.js';
import { SocketHandleAdapter } from '../handle.js';
import { createProcess } from './create-process.js';
import { setupServiceIO } from './setup-service-io.js';
import { setupServiceStdio } from './setup-service-stdio.js';
import { spawnWorker } from './spawn-worker.js';
import { printk } from './printk.js';

/**
 * Spawn a service handler process.
 *
 * @param self - Kernel instance
 * @param name - Service name
 * @param def - Service definition
 * @param socket - Optional socket for TCP activation
 * @param activation - Optional activation message
 */
export async function spawnServiceHandler(
    self: Kernel,
    name: string,
    def: ServiceDef,
    socket?: Socket,
    activation?: Message
): Promise<void> {
    const entry = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';
    const proc = createProcess(self, { cmd: def.handler });

    proc.activationMessage = activation;

    // Setup stdio
    if (socket) {
        const stat = socket.stat();
        const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
        const adapter = new SocketHandleAdapter(self.hal.entropy.uuid(), socket, description);
        self.handles.set(adapter.id, adapter);
        self.handleRefs.set(adapter.id, 3);
        proc.handles.set(0, adapter.id);
        proc.handles.set(1, adapter.id);
        proc.handles.set(2, adapter.id);
    } else if (def.io) {
        await setupServiceIO(self, proc, def);
    } else {
        await setupServiceStdio(self, proc, 0);
        await setupServiceStdio(self, proc, 1);
        await setupServiceStdio(self, proc, 2);
    }

    printk(self, 'spawn', `${name}: spawning worker for ${entry}`);
    proc.worker = await spawnWorker(self, proc, entry);
    proc.state = 'running';
    printk(self, 'spawn', `${name}: worker started (${proc.id.slice(0, 8)})`);

    self.processes.register(proc);
}
