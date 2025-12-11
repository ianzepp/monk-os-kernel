/**
 * Process Library
 *
 * Userland interface to Monk OS kernel. Provides message-based I/O
 * for pipeline composition.
 *
 * @module rom/lib/process
 */

import { syscall, call, collect, toError, setDefaultTermHandler } from './syscall.js';
import { respond } from './respond.js';
import type { Response, OpenFlags, SpawnOpts, ExitStatus, Stat, DirEntry, Grant } from './types.js';

// =============================================================================
// RE-EXPORTS
// =============================================================================

export * from './types.js';
export { respond } from './respond.js';
export { syscall, call, collect, onSignal, onTick, toError } from './syscall.js';
export type { SignalHandler, TickHandler } from './syscall.js';
export {
    debug,
    debugEnabled,
    debugPatterns,
    debugInit,
} from './debug.js';
export type { DebugLogger } from './debug.js';

// =============================================================================
// CONSTANTS
// =============================================================================

export const SIGTERM = 15;
export const SIGKILL = 9;
export const SIGTICK = 30;

// =============================================================================
// FILE OPERATIONS
// =============================================================================

/**
 * Open a file and return a file descriptor.
 */
export function open(path: string, flags?: OpenFlags): Promise<number> {
    return call<number>('file:open', path, flags ?? { read: true });
}

/**
 * Close a file descriptor.
 */
export function close(fd: number): Promise<void> {
    return call<void>('file:close', fd);
}

/**
 * Read binary data from a file descriptor.
 * Yields Uint8Array chunks until EOF.
 */
export async function* read(fd: number): AsyncIterable<Uint8Array> {
    for await (const r of syscall('file:read', fd)) {
        if (r.op === 'data' && r.bytes) {
            yield r.bytes;
        }
        else if (r.op === 'done' || r.op === 'ok') {
            return;
        }
        else if (r.op === 'error') {
            throw toError(r);
        }
    }
}

/**
 * Write data to a file descriptor.
 */
export async function write(fd: number, data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

    return call<void>('file:write', fd, bytes);
}

/**
 * Get file stats by path.
 */
export function stat(path: string): Promise<Stat> {
    return call<Stat>('file:stat', path);
}

/**
 * Rename a file or directory.
 */
export function rename(oldPath: string, newPath: string): Promise<void> {
    return call<void>('file:rename', oldPath, newPath);
}

/**
 * Remove a file.
 */
export function unlink(path: string): Promise<void> {
    return call<void>('file:unlink', path);
}

/**
 * Copy a file.
 */
export async function copyFile(src: string, dest: string): Promise<void> {
    const srcFd = await open(src, { read: true });
    const destFd = await open(dest, { write: true, create: true, truncate: true });

    try {
        for await (const chunk of read(srcFd)) {
            await write(destFd, chunk);
        }
    }
    finally {
        await close(srcFd);
        await close(destFd);
    }
}

/**
 * Write string content to a file (creates or overwrites).
 */
export async function writeFile(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, truncate: true });

    try {
        await write(fd, content);
    }
    finally {
        await close(fd);
    }
}

/**
 * Append string content to a file (creates if doesn't exist).
 */
export async function appendFile(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, append: true });

    try {
        await write(fd, content);
    }
    finally {
        await close(fd);
    }
}

// =============================================================================
// FILE HELPERS
// =============================================================================

/**
 * Read entire file contents as bytes.
 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
    const fd = await open(path, { read: true });

    try {
        const chunks: Uint8Array[] = [];
        let totalLength = 0;

        for await (const chunk of read(fd)) {
            chunks.push(chunk);
            totalLength += chunk.length;
        }

        const result = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result;
    }
    finally {
        await close(fd);
    }
}

/**
 * Read entire file contents as text.
 */
export async function readText(path: string): Promise<string> {
    const bytes = await readFileBytes(path);

    return new TextDecoder().decode(bytes);
}

/**
 * Alias for readText (common name).
 */
export const readFile = readText;

/**
 * Read first N lines from a file.
 */
export async function head(path: string, lines: number): Promise<string[]> {
    const text = await readText(path);
    const allLines = text.split('\n');

    return allLines.slice(0, lines);
}

/**
 * ByteReader - buffered byte reading from async byte stream.
 */
export class ByteReader {
    private buffer: Uint8Array = new Uint8Array(0);
    private iterator: AsyncIterator<Uint8Array>;
    private done = false;

    constructor(source: AsyncIterable<Uint8Array>) {
        this.iterator = source[Symbol.asyncIterator]();
    }

    /**
     * Read exactly n bytes, or less if EOF reached.
     */
    async read(n: number): Promise<Uint8Array | null> {
        while (this.buffer.length < n && !this.done) {
            const result = await this.iterator.next();

            if (result.done) {
                this.done = true;
                break;
            }

            const newBuffer = new Uint8Array(this.buffer.length + result.value.length);

            newBuffer.set(this.buffer);
            newBuffer.set(result.value, this.buffer.length);
            this.buffer = newBuffer;
        }

        if (this.buffer.length === 0) {
            return null;
        }

        const toRead = Math.min(n, this.buffer.length);
        const result = this.buffer.slice(0, toRead);

        this.buffer = this.buffer.slice(toRead);

        return result;
    }

    /**
     * Read a line (up to \n).
     */
    async readLine(): Promise<string | null> {
        const decoder = new TextDecoder();
        let line = '';

        while (true) {
            const idx = this.buffer.indexOf(10); // \n

            if (idx !== -1) {
                line += decoder.decode(this.buffer.slice(0, idx));
                this.buffer = this.buffer.slice(idx + 1);

                return line;
            }

            line += decoder.decode(this.buffer);
            this.buffer = new Uint8Array(0);

            if (this.done) {
                return line.length > 0 ? line : null;
            }

            const result = await this.iterator.next();

            if (result.done) {
                this.done = true;

                return line.length > 0 ? line : null;
            }

            this.buffer = result.value;
        }
    }
}

// =============================================================================
// MESSAGE I/O (stdin/stdout)
// =============================================================================

/**
 * Receive messages from a file descriptor.
 * Used for stdin (fd 0) and pipes.
 */
export async function* recv(fd: number): AsyncIterable<Response> {
    for await (const r of syscall('file:recv', fd)) {
        yield r;

        if (r.op === 'done' || r.op === 'ok' || r.op === 'error') {
            return;
        }
    }
}

/**
 * Send a message to a file descriptor.
 * Used for stdout (fd 1), stderr (fd 2), and pipes.
 */
export function send(fd: number, msg: Response): Promise<void> {
    return call<void>('file:send', fd, msg);
}

// =============================================================================
// CONSOLE I/O
// =============================================================================

/**
 * Print text to stdout (no newline).
 */
export async function print(text: string): Promise<void> {
    await send(1, respond.item({ text }));
}

/**
 * Print line to stdout (with newline).
 */
export async function println(text: string): Promise<void> {
    await send(1, respond.item({ text: text + '\n' }));
}

/**
 * Print error line to stderr (with newline).
 */
export async function eprintln(text: string): Promise<void> {
    await send(2, respond.item({ text: text + '\n' }));
}

// =============================================================================
// DIRECTORY OPERATIONS
// =============================================================================

/**
 * Create a directory.
 */
export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return call<void>('file:mkdir', path, opts);
}

/**
 * Remove a directory.
 */
export function rmdir(path: string): Promise<void> {
    return call<void>('file:rmdir', path);
}

/**
 * Read all directory entries.
 */
export function readdirAll(path: string): Promise<DirEntry[]> {
    return collect<DirEntry>('file:readdir', path);
}

// =============================================================================
// PROCESS OPERATIONS
// =============================================================================

/**
 * Exit the current process.
 */
export async function exit(code: number): Promise<never> {
    await call<void>('proc:exit', code);

    // Should never reach here - kernel terminates the worker
    throw new Error('Process should have exited');
}

/**
 * Spawn a child process.
 * Returns the child's PID.
 */
export function spawn(entry: string, opts?: SpawnOpts): Promise<number> {
    return call<number>('proc:spawn', entry, opts);
}

/**
 * Wait for a child process to exit.
 */
export function wait(pid: number, timeout?: number): Promise<ExitStatus> {
    return call<ExitStatus>('proc:wait', pid, timeout);
}

/**
 * Get the current process ID.
 */
export function getpid(): Promise<number> {
    return call<number>('proc:getpid');
}

/**
 * Get the parent process ID.
 */
export function getppid(): Promise<number> {
    return call<number>('proc:getppid');
}

/**
 * Send a signal to a process.
 *
 * @param pid - Target process PID
 * @param signal - Signal number (default: SIGTERM/15)
 */
export function kill(pid: number, signal?: number): Promise<void> {
    return call<void>('proc:kill', pid, signal);
}

/**
 * Process info returned by proc:list.
 */
export interface ProcessInfo {
    /** Process ID (local to parent) */
    pid: number;
    /** Parent process ID */
    ppid: number;
    /** Process state */
    state: string;
    /** Command/entry point */
    cmd: string;
    /** User identity */
    user: string;
}

/**
 * List all processes.
 */
export function listProcesses(): Promise<ProcessInfo[]> {
    return call<ProcessInfo[]>('proc:list');
}

/**
 * Get command-line arguments.
 */
export function getargs(): Promise<string[]> {
    return call<string[]>('proc:getargs');
}

// =============================================================================
// ENVIRONMENT
// =============================================================================

/**
 * Get current working directory.
 */
export function getcwd(): Promise<string> {
    return call<string>('proc:getcwd');
}

/**
 * Change working directory.
 */
export function chdir(path: string): Promise<void> {
    return call<void>('proc:chdir', path);
}

/**
 * Get environment variable, or all variables if no name provided.
 */
export function getenv(name: string): Promise<string | undefined>;
export function getenv(): Promise<Record<string, string>>;
export function getenv(name?: string): Promise<string | undefined | Record<string, string>> {
    if (name === undefined) {
        return call<Record<string, string>>('proc:getenv');
    }

    return call<string | undefined>('proc:getenv', name);
}

/**
 * Set environment variable.
 */
export function setenv(name: string, value: string): Promise<void> {
    return call<void>('proc:setenv', name, value);
}

// =============================================================================
// SIGNALS
// =============================================================================

/**
 * Sleep for specified milliseconds.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Subscribe to kernel ticks.
 *
 * After subscribing, register a tick handler with onTick() to receive
 * tick signals. Each tick provides timing info: dt, now, seq.
 */
export function subscribeTicks(): Promise<void> {
    return call<void>('proc:tick:subscribe');
}

/**
 * Unsubscribe from kernel ticks.
 */
export function unsubscribeTicks(): Promise<void> {
    return call<void>('proc:tick:unsubscribe');
}

// Note: onSignal is re-exported from syscall.ts

// =============================================================================
// PIPES
// =============================================================================

/**
 * Create a pipe pair.
 * Returns [recvFd, sendFd].
 */
export function pipe(): Promise<[number, number]> {
    return call<[number, number]>('ipc:pipe');
}

/**
 * Redirect a handle to point to another handle's resource.
 * Returns saved handle ID for later restoration.
 */
export function redirect(target: number, source: number): Promise<string> {
    return call<string>('handle:redirect', target, source);
}

/**
 * Create an output redirect (for shell > and >> operators).
 * Opens a file and redirects stdout to it.
 * Returns saved handle ID.
 */
export async function outputRedirect(
    path: string,
    opts: { append?: boolean } = {},
): Promise<{ fd: number; saved: string }> {
    const fd = await open(path, {
        write: true,
        create: true,
        truncate: !opts.append,
        append: opts.append,
    });

    const saved = await redirect(1, fd);

    return { fd, saved };
}

/**
 * Restore a previously redirected handle.
 */
export function restore(target: number, saved: string): Promise<void> {
    return call<void>('handle:restore', target, saved);
}

// =============================================================================
// ACCESS CONTROL
// =============================================================================

/**
 * Get or set access control for a path.
 * If acl is undefined, returns current ACL.
 * If acl is provided, sets the ACL.
 */
export function access(path: string, acl?: Grant[] | null): Promise<Grant[] | void> {
    return call<Grant[] | void>('file:access', path, acl);
}

/**
 * Create a symbolic link.
 */
export function symlink(target: string, linkPath: string): Promise<void> {
    return call<void>('file:symlink', target, linkPath);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

// Set up default SIGTERM handler to exit gracefully
setDefaultTermHandler(() => {
    exit(0).catch(() => {});
});
