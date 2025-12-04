/**
 * Unified activation loop for services.
 *
 * @module kernel/kernel/run-activation-loop
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import type { Port, PortMessage } from '../resource.js';
import type { Socket } from '../../hal/network.js';
import type { Message } from '../../message.js';
import { spawnServiceHandler } from './spawn-service-handler.js';
import { logServiceError } from './log-service-error.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Unified activation loop for services.
 *
 * @param self - Kernel instance
 * @param name - Service name
 * @param def - Service definition
 * @param port - Activation port
 * @param signal - Abort signal
 * @param transform - Transform function for port messages
 */
export async function runActivationLoop(
    self: Kernel,
    name: string,
    def: ServiceDef,
    port: Port,
    signal: AbortSignal,
    transform: (msg: PortMessage) => {
        socket?: Socket;
        activation?: Message;
    } | null
): Promise<void> {
    try {
        while (!signal.aborted) {
            const msg = await port.recv();

            if (signal.aborted) {
                // Cleanup socket if present
                if (msg.socket) {
                    await msg.socket.close().catch((err) => {
                        printk(self, 'cleanup', `socket close on abort: ${formatError(err)}`);
                    });
                }
                break;
            }

            const input = transform(msg);
            if (input) {
                spawnServiceHandler(self, name, def, input.socket, input.activation).catch((err) => {
                    logServiceError(self, name, 'spawn failed', err);
                    if (input.socket) {
                        input.socket.close().catch((closeErr) => {
                            printk(self, 'cleanup', `socket close on error: ${formatError(closeErr)}`);
                        });
                    }
                });
            }
        }
    } catch (err) {
        if (!signal.aborted) {
            logServiceError(self, name, 'activation loop error', err);
        }
    }
}
