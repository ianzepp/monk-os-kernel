/**
 * Channel Accept Syscall - Wrap accepted socket in protocol channel
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This syscall wraps an already-accepted TCP socket in a protocol-aware channel.
 * Unlike channel:open (which creates client connections), this is for server-side
 * channels that need to handle incoming connections.
 *
 * Use case:
 * 1. Process creates tcp:listen port via port:create
 * 2. Process calls port:recv to accept connection, gets socket fd
 * 3. Process calls channel:accept to wrap socket in HTTP/SSE/etc channel
 * 4. Process uses channel:recv/channel:push for protocol-aware I/O
 *
 * SUPPORTED PROTOCOLS
 * ===================
 * - http / http-server: HTTP request/response handling
 * - sse: Server-Sent Events (push from server to client)
 *
 * WHY THIS SYSCALL?
 * =================
 * - Separates connection acceptance (TCP layer) from protocol handling
 * - Allows same socket to be wrapped in different protocols
 * - Enables protocol detection before wrapping (future: auto-detect HTTP vs WS)
 *
 * @module kernel/kernel/accept-channel
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { ChannelOpts } from '../../hal/index.js';
import { EBADF, EINVAL } from '../../hal/errors.js';
import { ChannelHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';
import { getHandle } from './get-handle.js';
import { printk } from './printk.js';
import type { SocketHandleAdapter } from '../handle/socket.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Wrap an accepted socket in a protocol-aware channel.
 *
 * Takes ownership of the socket - caller should not use the socket fd after this.
 * The socket fd is closed and a new channel fd is returned.
 *
 * @param self - Kernel instance
 * @param proc - Calling process
 * @param socketFd - Socket descriptor from port:recv
 * @param proto - Protocol to wrap (http, http-server, sse)
 * @param opts - Protocol-specific options
 * @returns Channel file descriptor
 * @throws EINVAL - Invalid protocol or socket
 * @throws EBADF - Bad socket descriptor
 */
export async function acceptChannel(
    self: Kernel,
    proc: Process,
    socketFd: number,
    proto: string,
    opts?: ChannelOpts,
): Promise<number> {
    // Get socket handle
    const socketHandle = getHandle(self, proc, socketFd);

    if (!socketHandle) {
        throw new EBADF(`Bad socket descriptor ${socketFd}`);
    }

    if (socketHandle.type !== 'socket') {
        throw new EINVAL(`Handle ${socketFd} is not a socket (type: ${socketHandle.type})`);
    }

    // Get underlying socket from handle
    const socketAdapter = socketHandle as SocketHandleAdapter;
    const socket = socketAdapter.getSocket();

    if (!socket) {
        throw new EBADF(`Socket ${socketFd} has no underlying socket`);
    }

    // Create channel wrapping the socket
    const channel = await self.hal.channel.accept(socket, proto, opts);

    // Wrap channel in adapter for Handle interface
    const adapter = new ChannelHandleAdapter(
        channel.id,
        channel,
        channel.description,
    );

    // Remove socket fd from process's handle table WITHOUT closing the socket
    // The channel now owns the socket and will close it when the channel closes
    // Just remove the fd mapping - don't call unrefHandle which would close it
    proc.handles.delete(socketFd);

    // Allocate new fd for channel
    const channelFd = allocHandle(self, proc, adapter);

    printk(
        self,
        'channel',
        `accepted ${channel.proto}:${channel.description} as fd ${channelFd} (was socket fd ${socketFd})`,
    );

    return channelFd;
}
