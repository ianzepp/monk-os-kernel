/**
 * Network operations for VFS scripts.
 */

import type { TcpListenOpts, PortMessage, WatchOpts, UdpOpts, PubsubOpts } from './types';
import { call } from './syscall';

/**
 * Connect to a TCP server.
 * @param host - Hostname or IP address
 * @param port - Port number
 * @returns File descriptor for the socket
 */
export function connect(host: string, port: number): Promise<number> {
    return call<number>('connect', 'tcp', host, port);
}

/**
 * Connect to a Unix domain socket.
 * @param path - Path to the socket file
 * @returns File descriptor for the socket
 */
export function unix(path: string): Promise<number> {
    return call<number>('connect', 'unix', path);
}

/**
 * Create a TCP listener port.
 * @param opts - Listen options (port, host, backlog)
 * @returns Port handle
 */
export function listen(opts: TcpListenOpts): Promise<number> {
    return call<number>('port', 'tcp:listen', opts);
}

/**
 * Create a VFS watch port.
 * @param pattern - Glob pattern to watch (e.g., '/tmp/**')
 * @returns Port handle
 */
export function watch(pattern: string): Promise<number>;
export function watch(opts: WatchOpts): Promise<number>;
export function watch(patternOrOpts: string | WatchOpts): Promise<number> {
    const opts = typeof patternOrOpts === 'string' ? { pattern: patternOrOpts } : patternOrOpts;
    return call<number>('port', 'watch', opts);
}

/**
 * Create a UDP port.
 * @param opts - UDP options (bind port, address)
 * @returns Port handle
 */
export function udp(opts: UdpOpts): Promise<number> {
    return call<number>('port', 'udp', opts);
}

/**
 * Create a pubsub port.
 * @param opts - Pubsub options (subscribe patterns)
 * @returns Port handle
 */
export function pubsub(opts?: PubsubOpts): Promise<number> {
    return call<number>('port', 'pubsub', opts);
}

/**
 * Receive a message from a port.
 * @param portId - Port handle
 * @returns Port message with from, data, fd, meta
 */
export function portRecv(portId: number): Promise<PortMessage> {
    return call<PortMessage>('port:recv', portId);
}

/**
 * Send a message to a port (UDP/pubsub).
 * @param portId - Port handle
 * @param to - Destination address or topic
 * @param data - Data to send
 */
export function portSend(portId: number, to: string, data: Uint8Array): Promise<void> {
    return call<void>('port:send', portId, to, data);
}

/**
 * Close a port.
 * @param portId - Port handle
 */
export function pclose(portId: number): Promise<void> {
    return call<void>('port:close', portId);
}
