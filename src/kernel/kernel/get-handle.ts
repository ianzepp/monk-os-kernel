/**
 * Get a handle by process-local file descriptor.
 *
 * @module kernel/kernel/get-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Handle } from '../handle.js';

/**
 * Get a handle by process-local file descriptor.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param h - Handle number (fd)
 * @returns Handle or undefined
 */
export function getHandle(self: Kernel, proc: Process, h: number): Handle | undefined {
    const handleId = proc.handles.get(h);
    if (!handleId) {
        return undefined;
    }
    return self.handles.get(handleId);
}
