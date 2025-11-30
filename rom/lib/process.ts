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

function reconstructError(error: Error & { code?: string }): Error {
    if (error.code) {
        return new SyscallError(error.code, error.message);
    }
    return error;
}

async function withTypedErrors<T>(promise: Promise<T>): Promise<T> {
    try {
        return await promise;
    } catch (error) {
        throw reconstructError(error as Error & { code?: string });
    }
}

// ============================================================================
// Syscall Transport
// ============================================================================

interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}

type SignalHandler = (signal: number) => void;

const pending = new Map<string, PendingRequest>();
let signalHandler: SignalHandler | null = null;
let initialized = false;

function initTransport(): void {
    if (initialized) return;

    self.onmessage = (event: MessageEvent) => {
        const msg = event.data;

        if (msg.type === 'response') {
            const req = pending.get(msg.id);
            if (req) {
                pending.delete(msg.id);
                if (msg.error) {
                    const error = new Error(msg.error.message) as Error & { code: string };
                    error.code = msg.error.code;
                    req.reject(error);
                } else {
                    req.resolve(msg.result);
                }
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

function syscall<T>(name: string, ...args: unknown[]): Promise<T> {
    if (!initialized) {
        initTransport();
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });

        self.postMessage({
            type: 'syscall',
            id,
            name,
            args,
        });
    });
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
    return withTypedErrors(syscall<number>('open', path, flags ?? { read: true }));
}

export function close(fd: number): Promise<void> {
    return withTypedErrors(syscall<void>('close', fd));
}

export function read(fd: number, size?: number): Promise<Uint8Array> {
    return withTypedErrors(syscall<Uint8Array>('read', fd, size));
}

export function write(fd: number, data: Uint8Array): Promise<number> {
    return withTypedErrors(syscall<number>('write', fd, data));
}

export function seek(fd: number, offset: number, whence?: SeekWhence): Promise<number> {
    return withTypedErrors(syscall<number>('seek', fd, offset, whence ?? 'start'));
}

export function stat(path: string): Promise<Stat> {
    return withTypedErrors(syscall<Stat>('stat', path));
}

export function fstat(fd: number): Promise<Stat> {
    return withTypedErrors(syscall<Stat>('fstat', fd));
}

export function mkdir(path: string, opts?: MkdirOpts): Promise<void> {
    return withTypedErrors(syscall<void>('mkdir', path, opts));
}

export function unlink(path: string): Promise<void> {
    return withTypedErrors(syscall<void>('unlink', path));
}

export function rmdir(path: string): Promise<void> {
    return withTypedErrors(syscall<void>('rmdir', path));
}

export function readdir(path: string): Promise<string[]> {
    return withTypedErrors(syscall<string[]>('readdir', path));
}

export function rename(oldPath: string, newPath: string): Promise<void> {
    return withTypedErrors(syscall<void>('rename', oldPath, newPath));
}

// ============================================================================
// Access Control
// ============================================================================

export function access(path: string): Promise<ACL>;
export function access(path: string, acl: ACL | null): Promise<void>;
export function access(path: string, acl?: ACL | null): Promise<ACL | void> {
    if (acl === undefined) {
        return withTypedErrors(syscall<ACL>('access', path));
    }
    return withTypedErrors(syscall<void>('access', path, acl));
}

// ============================================================================
// Pipe Operations
// ============================================================================

export function pipe(): Promise<[number, number]> {
    return withTypedErrors(syscall<[number, number]>('pipe'));
}

export async function redirect(targetFd: number, sourceFd: number): Promise<() => Promise<void>> {
    const saved = await withTypedErrors(
        syscall<string>('redirect', { target: targetFd, source: sourceFd })
    );

    return async () => {
        await withTypedErrors(syscall('restore', { target: targetFd, saved }));
    };
}

// ============================================================================
// Network Operations
// ============================================================================

export function connect(host: string, port: number): Promise<number> {
    return withTypedErrors(syscall<number>('connect', 'tcp', host, port));
}

export function listen(opts: TcpListenOpts): Promise<number> {
    return withTypedErrors(syscall<number>('port', 'tcp:listen', opts));
}

export function recv(portId: number): Promise<PortMessage> {
    return withTypedErrors(syscall<PortMessage>('recv', portId));
}

export function send(portId: number, to: string, data: Uint8Array): Promise<void> {
    return withTypedErrors(syscall<void>('send', portId, to, data));
}

export function pclose(portId: number): Promise<void> {
    return withTypedErrors(syscall<void>('pclose', portId));
}

// ============================================================================
// Process Operations
// ============================================================================

export function spawn(entry: string, opts?: SpawnOpts): Promise<number> {
    return withTypedErrors(syscall<number>('spawn', entry, opts));
}

export function exit(code: number): Promise<never> {
    return syscall<never>('exit', code);
}

export function kill(pid: number, signal?: number): Promise<void> {
    return withTypedErrors(syscall<void>('kill', pid, signal ?? SIGTERM));
}

export function wait(pid: number): Promise<ExitStatus> {
    return withTypedErrors(syscall<ExitStatus>('wait', pid));
}

export function getpid(): Promise<number> {
    return withTypedErrors(syscall<number>('getpid'));
}

export function getppid(): Promise<number> {
    return withTypedErrors(syscall<number>('getppid'));
}

export function getargs(): Promise<string[]> {
    return withTypedErrors(syscall<string[]>('getargs'));
}

// ============================================================================
// Environment Operations
// ============================================================================

export function getcwd(): Promise<string> {
    return withTypedErrors(syscall<string>('getcwd'));
}

export function chdir(path: string): Promise<void> {
    return withTypedErrors(syscall<void>('chdir', path));
}

export function getenv(name: string): Promise<string | undefined> {
    return withTypedErrors(syscall<string | undefined>('getenv', name));
}

export function setenv(name: string, value: string): Promise<void> {
    return withTypedErrors(syscall<void>('setenv', name, value));
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
