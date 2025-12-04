/**
 * Redirect a handle to point to another handle's resource.
 *
 * @module kernel/kernel/redirect-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';
import { refHandle } from './ref-handle.js';

/**
 * Redirect a handle to point to another handle's resource.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param targetH - Target handle number
 * @param sourceH - Source handle number
 * @returns Saved handle ID for later restoration
 */
export function redirectHandle(
    self: Kernel,
    proc: Process,
    targetH: number,
    sourceH: number
): string {
    const sourceHandleId = proc.handles.get(sourceH);
    if (!sourceHandleId) {
        throw new EBADF(`Bad source file descriptor: ${sourceH}`);
    }

    const savedHandleId = proc.handles.get(targetH);
    if (!savedHandleId) {
        throw new EBADF(`Bad target file descriptor: ${targetH}`);
    }

    // Point target to source's handle
    proc.handles.set(targetH, sourceHandleId);
    refHandle(self, sourceHandleId);

    return savedHandleId;
}
