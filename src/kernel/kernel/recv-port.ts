/**
 * Receive from port handle.
 *
 * @module kernel/kernel/recv-port
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { ProcessPortMessage } from '../syscalls.js';
import { EBADF, EMFILE } from '../errors.js';
import { MAX_HANDLES } from '../types.js';
import { SocketHandleAdapter } from '../handle.js';
import { getPortFromHandle } from './get-port-from-handle.js';
import { allocHandle } from './alloc-handle.js';

/**
 * Receive from port handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param h - Handle number
 * @returns Port message
 */
export async function recvPort(
    self: Kernel,
    proc: Process,
    h: number
): Promise<ProcessPortMessage> {
    const port = getPortFromHandle(self, proc, h);
    if (!port) {
        throw new EBADF(`Bad port: ${h}`);
    }

    const msg = await port.recv();

    // If message contains a socket, wrap it
    if (msg.socket) {
        if (proc.handles.size >= MAX_HANDLES) {
            await msg.socket.close();
            throw new EMFILE('Too many open handles');
        }

        const stat = msg.socket.stat();
        const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
        const adapter = new SocketHandleAdapter(self.hal.entropy.uuid(), msg.socket, description);
        const fd = allocHandle(self, proc, adapter);

        return {
            from: msg.from,
            fd,
            meta: msg.meta,
        };
    }

    return {
        from: msg.from,
        data: msg.data,
        meta: msg.meta,
    };
}
