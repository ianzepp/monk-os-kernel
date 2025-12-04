/**
 * Get a channel from a handle.
 *
 * @module kernel/kernel/get-channel-from-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Channel } from '../../hal/index.js';
import { ChannelHandleAdapter } from '../handle.js';
import { getHandle } from './get-handle.js';

/**
 * Get a channel from a handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param h - Handle number
 * @returns Channel or undefined
 */
export function getChannelFromHandle(
    self: Kernel,
    proc: Process,
    h: number
): Channel | undefined {
    const handle = getHandle(self, proc, h);
    if (!handle || handle.type !== 'channel') {
        return undefined;
    }
    return (handle as ChannelHandleAdapter).getChannel();
}
