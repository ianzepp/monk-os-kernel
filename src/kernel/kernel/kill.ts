/**
 * Send signal to a process.
 *
 * PERMISSION MODEL:
 * - Process can signal itself
 * - Process can signal its children
 * - Init can signal anyone
 *
 * SIGTERM: Graceful termination with grace period, then SIGKILL
 * SIGKILL: Immediate termination, no cleanup
 *
 * @module kernel/kernel/kill
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { SIGTERM, SIGKILL, TERM_GRACE_MS } from '../types.js';
import { ESRCH, EPERM } from '../errors.js';
import { forceExit } from './force-exit.js';
import { deliverSignal } from './deliver-signal.js';
import { printk } from './printk.js';

/**
 * Send signal to a process.
 *
 * @param self - Kernel instance
 * @param caller - Process making the syscall
 * @param targetPid - PID to signal (in caller's namespace)
 * @param signal - Signal number (default SIGTERM)
 */
export function kill(
    self: Kernel,
    caller: Process,
    targetPid: number,
    signal: number = SIGTERM
): void {
    // Resolve PID to process
    const target = self.processes.resolvePid(caller, targetPid);
    if (!target) {
        throw new ESRCH(`No such process: ${targetPid}`);
    }

    // Permission check
    // WHY: Prevent arbitrary process from killing system processes
    if (target.parent !== caller.id && target.id !== caller.id) {
        const init = self.processes.getInit();
        if (caller !== init) {
            throw new EPERM(`Cannot signal process ${targetPid}`);
        }
    }

    printk(self, 'signal', `${caller.cmd} sending signal ${signal} to PID ${targetPid}`);

    if (signal === SIGKILL) {
        // Immediate termination
        forceExit(self, target, 128 + SIGKILL);
    } else if (signal === SIGTERM) {
        // Graceful termination
        deliverSignal(self, target, SIGTERM);

        // Schedule force kill after grace period
        // WHY: Process may not handle SIGTERM; we enforce termination
        self.deps.setTimeout(() => {
            if (target.state === 'running') {
                printk(self, 'signal', `Grace period expired for ${target.cmd}, force killing`);
                forceExit(self, target, 128 + SIGTERM);
            }
        }, TERM_GRACE_MS);
    }
}
