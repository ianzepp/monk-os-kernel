/**
 * Allocate a handle ID and register in process and kernel tables.
 *
 * @module kernel/kernel/alloc-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Handle } from '../handle.js';
import { EMFILE } from '../errors.js';
import { MAX_HANDLES } from '../types.js';

/**
 * Allocate a handle ID and register in process and kernel tables.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param handle - Handle to allocate
 * @returns File descriptor number
 * @throws EMFILE if too many open handles
 */
export function allocHandle(self: Kernel, proc: Process, handle: Handle): number {
    if (proc.handles.size >= MAX_HANDLES) {
        throw new EMFILE('Too many open handles');
    }

    // Register in kernel table
    self.handles.set(handle.id, handle);
    self.handleRefs.set(handle.id, 1);

    // Allocate fd in process
    const h = proc.nextHandle++;
    proc.handles.set(h, handle.id);

    return h;
}
