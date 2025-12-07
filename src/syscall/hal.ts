/**
 * HAL Syscalls - Network and channel operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * HAL syscalls provide the interface between user processes and the Hardware
 * Abstraction Layer for network connections, ports, and channels. Each syscall
 * is a standalone async generator function that receives explicit dependencies.
 *
 * This module covers:
 * - net:* syscalls - TCP/Unix socket connections
 * - port:* syscalls - Message-based ports (TCP listen, UDP, pubsub, watch)
 * - channel:* syscalls - Protocol-aware channels (HTTP, WebSocket, PostgreSQL)
 *
 * DESIGN: HAL syscalls need kernel and hal
 * ========================================
 * Most HAL operations require:
 * - kernel: For handle allocation and management
 * - hal: For underlying network/channel operations
 *
 * Some syscalls (like channel:call) only need kernel (to get handle) because
 * they delegate to the handle's exec() method.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Protocol arguments must be validated as strings
 * INV-2: Handle arguments must be validated as numbers
 * INV-3: Every syscall yields at least one Response
 * INV-4: Handle validity is checked before delegation
 *
 * @module syscall/hal
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { HAL, ChannelOpts } from '@src/hal/index.js';
import type { Process, Response, Message, ProcessPortMessage } from './types.js';
import { respond } from './types.js';

// Kernel functions for HAL operations
import { connectTcp } from '@src/kernel/kernel/connect-tcp.js';
import { createPort } from '@src/kernel/kernel/create-port.js';
import { getPortFromHandle } from '@src/kernel/kernel/get-port-from-handle.js';
import { recvPort } from '@src/kernel/kernel/recv-port.js';
import { closeHandle } from '@src/kernel/kernel/close-handle.js';
import { openChannel } from '@src/kernel/kernel/open-channel.js';
import { getChannelFromHandle } from '@src/kernel/kernel/get-channel-from-handle.js';

// =============================================================================
// NETWORK SYSCALLS (net:*)
// =============================================================================

/**
 * Connect to a network endpoint.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param hal - HAL instance (currently unused, kernel.hal used)
 * @param proto - Protocol (tcp, unix)
 * @param host - Hostname/IP for TCP, path for Unix
 * @param port - Port number for TCP (>0), or 0 for Unix
 */
export async function* netConnect(
    proc: Process,
    kernel: Kernel,
    _hal: HAL,
    proto: unknown,
    host: unknown,
    port?: unknown,
): AsyncIterable<Response> {
    if (typeof proto !== 'string') {
        yield respond.error('EINVAL', 'proto must be a string');

        return;
    }

    if (typeof host !== 'string') {
        yield respond.error('EINVAL', 'host must be a string');

        return;
    }

    switch (proto) {
        case 'tcp':
            if (typeof port !== 'number') {
                yield respond.error('EINVAL', 'port must be a number');

                return;
            }

            yield respond.ok(await connectTcp(kernel, proc, host, port));

            return;

        case 'unix':
            // Unix sockets use port=0 as discriminator
            yield respond.ok(await connectTcp(kernel, proc, host, 0));

            return;

        default:
            yield respond.error('EINVAL', `unsupported protocol: ${proto}`);
    }
}

// =============================================================================
// PORT SYSCALLS (port:*)
// =============================================================================

/**
 * Create a port for message-based I/O.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param type - Port type (tcp:listen, udp, pubsub, watch)
 * @param opts - Port-specific options
 */
export async function* portCreate(
    proc: Process,
    kernel: Kernel,
    type: unknown,
    opts?: unknown,
): AsyncIterable<Response> {
    if (typeof type !== 'string') {
        yield respond.error('EINVAL', 'type must be a string');

        return;
    }

    const fd = await createPort(kernel, proc, type, opts);

    yield respond.ok(fd);
}

/**
 * Close a port.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Port descriptor
 */
export async function* portClose(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    await closeHandle(kernel, proc, fd);
    yield respond.ok();
}

/**
 * Receive a message from a port.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Port descriptor
 */
export async function* portRecv(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    const port = getPortFromHandle(kernel, proc, fd);

    if (!port) {
        yield respond.error('EBADF', `Bad port: ${fd}`);

        return;
    }

    const msg: ProcessPortMessage = await recvPort(kernel, proc, fd);

    yield respond.ok(msg);
}

/**
 * Send a message through a port.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Port descriptor
 * @param to - Recipient address
 * @param data - Binary data to send
 */
export async function* portSend(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    to: unknown,
    data: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    if (typeof to !== 'string') {
        yield respond.error('EINVAL', 'to must be a string');

        return;
    }

    if (!(data instanceof Uint8Array)) {
        yield respond.error('EINVAL', 'data must be Uint8Array');

        return;
    }

    const port = getPortFromHandle(kernel, proc, fd);

    if (!port) {
        yield respond.error('EBADF', `Bad port: ${fd}`);

        return;
    }

    await port.send(to, data);
    yield respond.ok();
}

// =============================================================================
// CHANNEL SYSCALLS (channel:*)
// =============================================================================

/**
 * Open a protocol-aware channel.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param hal - HAL instance (currently unused, kernel.hal used)
 * @param proto - Protocol (http, https, ws, wss, postgres, sqlite, sse)
 * @param url - Connection URL
 * @param opts - Protocol-specific options
 */
export async function* channelOpen(
    proc: Process,
    kernel: Kernel,
    _hal: HAL,
    proto: unknown,
    url: unknown,
    opts?: unknown,
): AsyncIterable<Response> {
    if (typeof proto !== 'string') {
        yield respond.error('EINVAL', 'proto must be a string');

        return;
    }

    if (typeof url !== 'string') {
        yield respond.error('EINVAL', 'url must be a string');

        return;
    }

    const fd = await openChannel(kernel, proc, proto, url, opts as ChannelOpts | undefined);

    yield respond.ok(fd);
}

/**
 * Close a channel.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Channel descriptor
 */
export async function* channelClose(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    await closeHandle(kernel, proc, fd);
    yield respond.ok();
}

/**
 * Call a channel and receive responses until terminal.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Channel descriptor
 * @param msg - Message to send
 */
export async function* channelCall(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    msg: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    const channel = getChannelFromHandle(kernel, proc, fd);

    if (!channel) {
        yield respond.error('EBADF', `Bad channel: ${fd}`);

        return;
    }

    // Delegate to channel and yield until terminal response
    for await (const response of channel.handle(msg as Message)) {
        yield response;
        if (response.op === 'ok' || response.op === 'error' || response.op === 'done') {
            return;
        }
    }

    yield respond.error('EIO', 'No response from channel');
}

/**
 * Stream responses from a channel.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Channel descriptor
 * @param msg - Message to send
 */
export async function* channelStream(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    msg: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    const channel = getChannelFromHandle(kernel, proc, fd);

    if (!channel) {
        yield respond.error('EBADF', `Bad channel: ${fd}`);

        return;
    }

    yield* channel.handle(msg as Message);
}

/**
 * Push a response to a channel.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Channel descriptor
 * @param response - Response to push
 */
export async function* channelPush(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
    response: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    const channel = getChannelFromHandle(kernel, proc, fd);

    if (!channel) {
        yield respond.error('EBADF', `Bad channel: ${fd}`);

        return;
    }

    await channel.push(response as Response);
    yield respond.ok();
}

/**
 * Receive a response from a channel.
 *
 * @param proc - Calling process
 * @param kernel - Kernel instance
 * @param fd - Channel descriptor
 */
export async function* channelRecv(
    proc: Process,
    kernel: Kernel,
    fd: unknown,
): AsyncIterable<Response> {
    if (typeof fd !== 'number') {
        yield respond.error('EINVAL', 'fd must be a number');

        return;
    }

    const channel = getChannelFromHandle(kernel, proc, fd);

    if (!channel) {
        yield respond.error('EBADF', `Bad channel: ${fd}`);

        return;
    }

    const msg = await channel.recv();

    yield respond.ok(msg);
}
