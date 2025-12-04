/**
 * Connect TCP or Unix socket and allocate handle.
 *
 * @module kernel/kernel/connect-tcp
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { SocketHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';

/**
 * Connect TCP or Unix socket and allocate handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param host - Host to connect to
 * @param port - Port number (0 for Unix socket)
 * @returns File descriptor number
 */
export async function connectTcp(
    self: Kernel,
    proc: Process,
    host: string,
    port: number
): Promise<number> {
    const socket = await self.hal.network.connect(host, port);

    const isUnix = port === 0;
    const description = isUnix
        ? `unix:${host}`
        : `tcp:${socket.stat().remoteAddr}:${socket.stat().remotePort}`;
    const adapter = new SocketHandleAdapter(self.hal.entropy.uuid(), socket, description);
    return allocHandle(self, proc, adapter);
}
