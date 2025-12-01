/**
 * Process Library for VFS Scripts
 *
 * Provides syscall wrappers for VFS-based scripts.
 */

/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// Error Handling
// ============================================================================

class SyscallError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = code;
    }
}

// ============================================================================
// Syscall Transport (Streams-First Architecture)
// ============================================================================

/**
 * Stream state for accumulating responses from kernel
 */
interface StreamState {
    queue: Response[];
    resolve: (() => void) | null;
    done: boolean;
}

type SignalHandler = (signal: number) => void;

const streams = new Map<string, StreamState>();
let signalHandler: SignalHandler | null = null;
let initialized = false;

/** Time-based ping interval in milliseconds */
const PING_INTERVAL_MS = 100;

function initTransport(): void {
    if (initialized) return;

    self.onmessage = (event: MessageEvent) => {
        const msg = event.data;

        if (msg.type === 'response') {
            const stream = streams.get(msg.id);
            if (stream) {
                stream.queue.push(msg.result as Response);
                // Check for terminal ops
                const op = (msg.result as Response).op;
                if (op === 'ok' || op === 'done' || op === 'error' || op === 'redirect') {
                    stream.done = true;
                }
                stream.resolve?.();
                stream.resolve = null;
            }
        } else if (msg.type === 'signal') {
            if (signalHandler) {
                signalHandler(msg.signal);
            } else if (msg.signal === 15) {
                // Default: exit on SIGTERM
                self.postMessage({
                    type: 'syscall',
                    id: crypto.randomUUID(),
                    name: 'exit',
                    args: [128 + msg.signal],
                });
            }
        }
    };

    initialized = true;
}

/**
 * Core syscall function - yields Response objects.
 * Includes automatic time-based ping with progress count for backpressure.
 */
async function* syscall(name: string, ...args: unknown[]): AsyncIterable<Response> {
    if (!initialized) {
        initTransport();
    }

    const id = crypto.randomUUID();
    const stream: StreamState = { queue: [], resolve: null, done: false };
    streams.set(id, stream);

    let processed = 0;
    let lastPingTime = Date.now();

    try {
        self.postMessage({ type: 'syscall', id, name, args });

        while (true) {
            // Wait for responses
            while (stream.queue.length === 0 && !stream.done) {
                await new Promise<void>(r => { stream.resolve = r; });
            }

            // Yield all queued responses
            while (stream.queue.length > 0) {
                const response = stream.queue.shift()!;
                yield response;
                processed++;

                // Time-based ping with progress count
                const now = Date.now();
                if (now - lastPingTime >= PING_INTERVAL_MS) {
                    self.postMessage({ type: 'stream_ping', id, processed });
                    lastPingTime = now;
                }

                // Terminal ops end the stream
                if (response.op === 'ok' || response.op === 'done' || response.op === 'error' || response.op === 'redirect') {
                    return;
                }
            }

            if (stream.done) return;
        }
    } finally {
        streams.delete(id);
        self.postMessage({ type: 'stream_cancel', id });
    }
}

/**
 * Convenience: unwrap single ok value (most common case)
 */
async function call<T>(name: string, ...args: unknown[]): Promise<T> {
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'ok') return response.data as T;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
    }
    throw new SyscallError('EIO', 'No response');
}

/**
 * Convenience: collect items to array
 */
async function collect<T>(name: string, ...args: unknown[]): Promise<T[]> {
    const items: T[] = [];
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'item') items.push(response.data as T);
        if (response.op === 'done') return items;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
        if (response.op === 'ok') return [response.data as T]; // Single value as array
    }
    return items;
}

/**
 * Convenience: iterate items (hide Response wrapper)
 */
async function* iterate<T>(name: string, ...args: unknown[]): AsyncIterable<T> {
    for await (const response of syscall(name, ...args)) {
        if (response.op === 'item') yield response.data as T;
        if (response.op === 'ok') { yield response.data as T; return; }
        if (response.op === 'done') return;
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new SyscallError(err.code, err.message);
        }
    }
}

// ============================================================================
// Types
// ============================================================================

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

export const SIGTERM = 15;
export const SIGKILL = 9;

// ============================================================================
// Signal Handler
// ============================================================================

export function onSignal(handler: SignalHandler): void {
    signalHandler = handler;
}

// ============================================================================
// File Operations
// ============================================================================

export function open(path: string, flags?: OpenFlags): Promise<number> {
    return call<number>('open', path, flags ?? { read: true });
}

export function close(fd: number): Promise<void> {
    return call<void>('close', fd);
}

export function read(fd: number, size?: number): Promise<Uint8Array> {
    return call<Uint8Array>('read', fd, size);
}

export function write(fd: number, data: Uint8Array): Promise<number> {
    return call<number>('write', fd, data);
}

export function seek(fd: number, offset: number, whence?: SeekWhence): Promise<number> {
    return call<number>('seek', fd, offset, whence ?? 'start');
}

export function stat(path: string): Promise<Stat> {
    return call<Stat>('stat', path);
}

export function fstat(fd: number): Promise<Stat> {
    return call<Stat>('fstat', fd);
}

export function mkdir(path: string, opts?: MkdirOpts): Promise<void> {
    return call<void>('mkdir', path, opts);
}

export function unlink(path: string): Promise<void> {
    return call<void>('unlink', path);
}

export function rmdir(path: string): Promise<void> {
    return call<void>('rmdir', path);
}

export function readdir(path: string): Promise<string[]> {
    return collect<string>('readdir', path);
}

/**
 * Stream directory entries (for large directories).
 */
export function readdirStream(path: string): AsyncIterable<string> {
    return iterate<string>('readdir', path);
}

export function rename(oldPath: string, newPath: string): Promise<void> {
    return call<void>('rename', oldPath, newPath);
}

export function symlink(target: string, linkPath: string): Promise<void> {
    return call<void>('symlink', target, linkPath);
}

// ============================================================================
// Access Control
// ============================================================================

export function access(path: string): Promise<ACL>;
export function access(path: string, acl: ACL | null): Promise<void>;
export function access(path: string, acl?: ACL | null): Promise<ACL | void> {
    if (acl === undefined) {
        return call<ACL>('access', path);
    }
    return call<void>('access', path, acl);
}

// ============================================================================
// Pipe Operations
// ============================================================================

export function pipe(): Promise<[number, number]> {
    return call<[number, number]>('pipe');
}

export async function redirect(targetFd: number, sourceFd: number): Promise<() => Promise<void>> {
    const saved = await call<string>('redirect', { target: targetFd, source: sourceFd });

    return async () => {
        await call('restore', { target: targetFd, saved });
    };
}

// ============================================================================
// Network Operations
// ============================================================================

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

// ============================================================================
// Channel Operations
// ============================================================================

/**
 * Channel API for protocol-aware message passing.
 */
export const channel = {
    /**
     * Open a channel to a remote service.
     */
    open(proto: string, url: string, opts?: ChannelOpts): Promise<number> {
        return call<number>('channel_open', proto, url, opts);
    },

    /**
     * Send a request and receive a single response.
     * Handles streaming under the hood (progress, events, etc).
     */
    async call<T = unknown>(ch: number, msg: Message): Promise<Response & { data?: T }> {
        for await (const response of syscall('channel_call', ch, msg)) {
            // Pass through progress/events but keep waiting for terminal
            if (response.op === 'ok' || response.op === 'error' || response.op === 'done' || response.op === 'redirect') {
                return response as Response & { data?: T };
            }
        }
        throw new SyscallError('EIO', 'No response from channel');
    },

    /**
     * Send a request and iterate streaming responses.
     */
    stream(ch: number, msg: Message): AsyncIterable<Response> {
        return syscall('channel_stream', ch, msg);
    },

    /**
     * Push a response to the remote (server-side channels).
     */
    push(ch: number, response: Response): Promise<void> {
        return call<void>('channel_push', ch, response);
    },

    /**
     * Receive a message from the remote (bidirectional channels).
     */
    recv(ch: number): Promise<Message> {
        return call<Message>('channel_recv', ch);
    },

    /**
     * Close a channel.
     */
    close(ch: number): Promise<void> {
        return call<void>('channel_close', ch);
    },
};

/**
 * Create an HTTP request message.
 */
export function httpRequest(request: HttpRequest): Message {
    return { op: 'request', data: request };
}

/**
 * Create a SQL query message.
 */
export function sqlQuery(sql: string, params?: unknown[], cursor?: boolean): Message {
    return { op: 'query', data: { sql, params, cursor } };
}

/**
 * Create a SQL execute message.
 */
export function sqlExecute(sql: string): Message {
    return { op: 'execute', data: { sql } };
}

// ============================================================================
// Process Operations
// ============================================================================

export function spawn(entry: string, opts?: SpawnOpts): Promise<number> {
    return call<number>('spawn', entry, opts);
}

export function exit(code: number): Promise<never> {
    return call<never>('exit', code);
}

export function kill(pid: number, signal?: number): Promise<void> {
    return call<void>('kill', pid, signal ?? SIGTERM);
}

export function wait(pid: number): Promise<ExitStatus> {
    return call<ExitStatus>('wait', pid);
}

export function getpid(): Promise<number> {
    return call<number>('getpid');
}

export function getppid(): Promise<number> {
    return call<number>('getppid');
}

export function getargs(): Promise<string[]> {
    return call<string[]>('getargs');
}

// ============================================================================
// Environment Operations
// ============================================================================

export function getcwd(): Promise<string> {
    return call<string>('getcwd');
}

export function chdir(path: string): Promise<void> {
    return call<void>('chdir', path);
}

export function getenv(name: string): Promise<string | undefined> {
    return call<string | undefined>('getenv', name);
}

export function setenv(name: string, value: string): Promise<void> {
    return call<void>('setenv', name, value);
}

// ============================================================================
// Convenience Functions
// ============================================================================

export async function readFile(path: string): Promise<string> {
    const fd = await open(path, { read: true });
    try {
        const chunks: Uint8Array[] = [];
        while (true) {
            const chunk = await read(fd, 65536);
            if (chunk.length === 0) break;
            chunks.push(chunk);
        }
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return new TextDecoder().decode(result);
    } finally {
        await close(fd);
    }
}

export async function writeFile(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, truncate: true });
    try {
        await write(fd, new TextEncoder().encode(content));
    } finally {
        await close(fd);
    }
}

export async function print(text: string): Promise<void> {
    await write(1, new TextEncoder().encode(text));
}

export async function println(text: string): Promise<void> {
    await write(1, new TextEncoder().encode(text + '\n'));
}

export async function eprint(text: string): Promise<void> {
    await write(2, new TextEncoder().encode(text));
}

export async function eprintln(text: string): Promise<void> {
    await write(2, new TextEncoder().encode(text + '\n'));
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
