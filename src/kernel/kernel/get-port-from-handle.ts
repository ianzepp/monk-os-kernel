/**
 * Get port from a handle.
 *
 * @module kernel/kernel/get-port-from-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Port } from '../resource.js';
import { PortHandleAdapter } from '../handle.js';
import { getHandle } from './get-handle.js';

/**
 * Get port from a handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param h - Handle number
 * @returns Port or undefined
 */
export function getPortFromHandle(
    self: Kernel,
    proc: Process,
    h: number
): Port | undefined {
    const handle = getHandle(self, proc, h);
    if (!handle || handle.type !== 'port') {
        return undefined;
    }
    return (handle as PortHandleAdapter).getPort();
}
