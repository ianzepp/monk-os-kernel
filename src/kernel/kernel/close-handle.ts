/**
 * Close a handle.
 *
 * @module kernel/kernel/close-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EBADF } from '../errors.js';
import { unrefHandle } from './unref-handle.js';

/**
 * Close a handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param h - Handle number (fd)
 */
export async function closeHandle(self: Kernel, proc: Process, h: number): Promise<void> {
    const handleId = proc.handles.get(h);
    if (!handleId) {
        throw new EBADF(`Bad file descriptor: ${h}`);
    }

    // Remove from process
    proc.handles.delete(h);

    // Decrement refcount
    unrefHandle(self, handleId);
}
