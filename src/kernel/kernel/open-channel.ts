/**
 * Open a channel and allocate handle.
 *
 * @module kernel/kernel/open-channel
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { ChannelOpts } from '../../hal/index.js';
import { ChannelHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';
import { printk } from './printk.js';

/**
 * Open a channel and allocate handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param proto - Protocol
 * @param url - URL
 * @param opts - Channel options
 * @returns File descriptor number
 */
export async function openChannel(
    self: Kernel,
    proc: Process,
    proto: string,
    url: string,
    opts?: ChannelOpts
): Promise<number> {
    const channel = await self.hal.channel.open(proto, url, opts);
    const adapter = new ChannelHandleAdapter(channel.id, channel, `${channel.proto}:${channel.description}`);
    const h = allocHandle(self, proc, adapter);

    printk(self, 'channel', `opened ${channel.proto}:${channel.description} as fd ${h}`);
    return h;
}
