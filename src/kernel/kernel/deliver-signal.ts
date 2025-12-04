/**
 * Deliver a signal to a process.
 *
 * @module kernel/kernel/deliver-signal
 */

import type { Kernel } from '../kernel.js';
import type { Process, SignalMessage } from '../types.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

/**
 * Deliver a signal to a process.
 *
 * @param self - Kernel instance
 * @param proc - Target process
 * @param signal - Signal number
 */
export function deliverSignal(self: Kernel, proc: Process, signal: number): void {
    const msg: SignalMessage = {
        type: 'signal',
        signal,
    };
    try {
        proc.worker.postMessage(msg);
    } catch (err) {
        printk(self, 'warn', `Failed to deliver signal to ${proc.cmd}: ${formatError(err)}`);
    }
}
