/**
 * Type definitions for VFS process library.
 */

export interface OpenFlags {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
}

export type SeekWhence = 'start' | 'current' | 'end';

export interface Stat {
    id: string;
    model: string;
    name: string;
    parent: string | null;
    owner: string;
    size: number;
    mtime: Date;
    ctime: Date;
}

export interface SpawnOpts {
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: number | 'pipe';
    stdout?: number | 'pipe';
    stderr?: number | 'pipe';
}

export interface ExitStatus {
    pid: number;
    code: number;
}

export interface PortMessage {
    from: string;
    fd?: number;
    data?: Uint8Array;
    meta?: Record<string, unknown>;
}

export interface TcpListenOpts {
    port: number;
    host?: string;
    backlog?: number;
}

export interface WatchOpts {
    pattern: string;
}

export interface UdpOpts {
    bind: number;
    address?: string;
}

export interface PubsubOpts {
    subscribe?: string | string[];
}

export interface PoolStats {
    pools: Record<string, {
        size: number;
        available: number;
        leased: number;
    }>;
}

export interface ChannelOpts {
    headers?: Record<string, string>;
    keepAlive?: boolean;
    timeout?: number;
    database?: string;
}

export interface HttpRequest {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    accept?: string;
}

export interface Message {
    op: string;
    data?: unknown;
}

export interface Response {
    op: 'ok' | 'error' | 'item' | 'chunk' | 'event' | 'progress' | 'done' | 'redirect';
    data?: unknown;
}

export interface Grant {
    to: string;
    ops: string[];
    expires?: number;
}

export interface ACL {
    grants: Grant[];
    deny: string[];
}

export interface MkdirOpts {
    recursive?: boolean;
}

export type SignalHandler = (signal: number) => void;
