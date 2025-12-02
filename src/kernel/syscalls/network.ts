/**
 * Network Syscalls
 *
 * Network operation syscalls (connect, port, recv, send, pclose)
 */

import type { HAL } from '@src/hal/index.js';
import type { Process } from '@src/kernel/types.js';
import type { Port } from '@src/kernel/resource.js';
import type { Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry, ProcessPortMessage } from './types.js';

/**
 * Create network syscalls.
 *
 * @param hal - HAL instance
 * @param connectTcp - Function to connect and allocate fd for socket
 * @param createPort - Function to create a port and allocate handle
 * @param getPort - Function to get port from handle
 * @param recvPort - Function to receive from port (auto-allocates handle for sockets)
 * @param closeHandle - Function to close handle
 */
export function createNetworkSyscalls(
    _hal: HAL,
    connectTcp: (proc: Process, host: string, port: number) => Promise<number>,
    createPort: (proc: Process, type: string, opts: unknown) => Promise<number>,
    getPort: (proc: Process, h: number) => Port | undefined,
    recvPort: (proc: Process, h: number) => Promise<ProcessPortMessage>,
    closeHandle: (proc: Process, h: number) => Promise<void>
): SyscallRegistry {
    return {
        async *connect(proc: Process, proto: unknown, host: unknown, port: unknown): AsyncIterable<Response> {
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
                    yield respond.ok(await connectTcp(proc, host, port));
                    return;

                case 'unix':
                    // Unix sockets use path as host, port=0
                    yield respond.ok(await connectTcp(proc, host, 0));
                    return;

                default:
                    yield respond.error('EINVAL', `unsupported protocol: ${proto}`);
            }
        },

        async *port(proc: Process, type: unknown, opts: unknown): AsyncIterable<Response> {
            if (typeof type !== 'string') {
                yield respond.error('EINVAL', 'type must be a string');
                return;
            }

            const portId = await createPort(proc, type, opts);
            yield respond.ok(portId);
        },

        async *'port:recv'(proc: Process, portId: unknown): AsyncIterable<Response> {
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }

            const port = getPort(proc, portId);
            if (!port) {
                yield respond.error('EBADF', `Bad port: ${portId}`);
                return;
            }

            const msg = await recvPort(proc, portId);
            yield respond.ok(msg);
        },

        async *'port:send'(proc: Process, portId: unknown, to: unknown, data: unknown): AsyncIterable<Response> {
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
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

            const port = getPort(proc, portId);
            if (!port) {
                yield respond.error('EBADF', `Bad port: ${portId}`);
                return;
            }

            await port.send(to, data);
            yield respond.ok();
        },

        async *'port:close'(proc: Process, portId: unknown): AsyncIterable<Response> {
            if (typeof portId !== 'number') {
                yield respond.error('EINVAL', 'portId must be a number');
                return;
            }

            await closeHandle(proc, portId);
            yield respond.ok();
        },
    };
}
