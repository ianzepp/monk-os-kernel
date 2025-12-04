/**
 * Restore a handle to its original resource.
 *
 * @module kernel/kernel/restore-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';

/**
 * Restore a handle to its original resource.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param targetH - Target handle number
 * @param savedHandleId - Saved handle ID to restore
 */
export function restoreHandle(
    self: Kernel,
    proc: Process,
    targetH: number,
    savedHandleId: string
): void {
    const currentHandleId = proc.handles.get(targetH);
    if (!currentHandleId) {
        throw new EBADF(`Bad file descriptor: ${targetH}`);
    }

    proc.handles.set(targetH, savedHandleId);

    // Decrement refcount on redirected handle
    const refs = (self.handleRefs.get(currentHandleId) ?? 1) - 1;
    if (refs <= 0) {
        self.handleRefs.delete(currentHandleId);
    } else {
        self.handleRefs.set(currentHandleId, refs);
    }
}
