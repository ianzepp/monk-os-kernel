/**
 * Setup stdio for a new process.
 *
 * Inherits file descriptors from parent and increments reference counts.
 *
 * ASSUMPTION: Parent's stdio handles exist.
 * If they don't (shouldn't happen), child runs with missing handles.
 *
 * @module kernel/kernel/setup-stdio
 */

import type { Kernel } from '../kernel.js';
import type { Process, SpawnOpts } from '../types.js';
import { refHandle } from './ref-handle.js';
import { printk } from './printk.js';

/**
 * Setup stdio for a new process.
 *
 * @param self - Kernel instance
 * @param proc - New process
 * @param parent - Parent process
 * @param opts - Spawn options (may override stdio)
 */
export function setupStdio(
    self: Kernel,
    proc: Process,
    parent: Process,
    opts?: SpawnOpts
): void {
    // Determine which handles to use
    const stdin = opts?.stdin ?? 0;
    const stdout = opts?.stdout ?? 1;
    const stderr = opts?.stderr ?? 2;

    // stdin
    if (typeof stdin === 'number') {
        const handleId = parent.handles.get(stdin);
        if (handleId) {
            proc.handles.set(0, handleId);
            refHandle(self, handleId);
        } else {
            // LOGGING: Missing handle is unexpected; log for debugging
            printk(self, 'warn', `Parent missing stdin handle ${stdin}`);
        }
    }
    // TODO: Handle stdin === 'pipe'

    // stdout
    if (typeof stdout === 'number') {
        const handleId = parent.handles.get(stdout);
        if (handleId) {
            proc.handles.set(1, handleId);
            refHandle(self, handleId);
        } else {
            printk(self, 'warn', `Parent missing stdout handle ${stdout}`);
        }
    }

    // stderr
    if (typeof stderr === 'number') {
        const handleId = parent.handles.get(stderr);
        if (handleId) {
            proc.handles.set(2, handleId);
            refHandle(self, handleId);
        } else {
            printk(self, 'warn', `Parent missing stderr handle ${stderr}`);
        }
    }
}
