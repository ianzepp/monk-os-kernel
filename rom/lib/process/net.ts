/**
 * Network operations for VFS scripts.
 */

import { TcpListenOpts, PortMessage } from './types';
import { call } from './syscall';

export function connect(host: string, port: number): Promise<number> {
    return call<number>('connect', 'tcp', host, port);
}

export function listen(opts: TcpListenOpts): Promise<number> {
    return call<number>('port', 'tcp:listen', opts);
}

export function recv(portId: number): Promise<PortMessage> {
    return call<PortMessage>('recv', portId);
}

export function send(portId: number, to: string, data: Uint8Array): Promise<void> {
    return call<void>('send', portId, to, data);
}

export function pclose(portId: number): Promise<void> {
    return call<void>('pclose', portId);
}
