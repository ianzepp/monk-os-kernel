/**
 * Process Library - Userland interface to Monk OS kernel
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Process Library provides the userland API for Monk OS. It runs inside
 * Bun Workers and translates function calls into syscall messages sent to
 * the kernel. This is analogous to libc in Unix systems - the bridge between
 * user code and kernel services.
 *
 * The library is organized into functional areas:
 * - File Operations: open, read, write, close, stat, etc.
 * - Process Operations: spawn, exit, kill, wait
 * - Network Operations: connect, listen, send, recv
 * - Environment Operations: getcwd, chdir, getenv, setenv
 * - Channel Operations: protocol-aware message passing
 *
 * SYSCALL FLOW
 * ============
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                     User Code (in Worker)                           │
 *   │                                                                     │
 *   │  const fd = await open('/etc/passwd');                              │
 *   │  const data = await read(fd);                                       │
 *   │  await close(fd);                                                   │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    ▼
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                     Process Library (this module)                   │
 *   │                                                                     │
 *   │  - Typed function wrappers                                          │
 *   │  - Error type reconstruction                                        │
 *   │  - Convenience helpers (readFile, println, etc.)                    │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    ▼
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                     Syscall Transport                               │
 *   │                                                                     │
 *   │  - UUID correlation                                                 │
 *   │  - postMessage to kernel                                            │
 *   │  - Promise resolution on response                                   │
 *   │                                                                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All syscalls return Promises (async communication)
 * INV-2: Errors are reconstructed to proper typed classes
 * INV-3: File descriptors are numbers, valid only within process
 * INV-4: exit() never returns (process terminates)
 *
 * CONCURRENCY MODEL
 * =================
 * Each process runs in its own Worker with a single-threaded event loop.
 * Async operations (syscalls) yield to the event loop, allowing multiple
 * concurrent operations. All syscalls are serialized at the kernel level.
 *
 * MEMORY MANAGEMENT
 * =================
 * - File descriptors are kernel-managed; close to release
 * - Port IDs are kernel-managed; pclose to release
 * - Channel IDs are kernel-managed; channel.close to release
 * - Worker memory is released on process exit
 *
 * @module process
 */

import { syscall } from './syscall.js';
import { fromCode } from '../errors.js';
import type { Response } from './types.js';

// =============================================================================
// SYSCALL RESPONSE HELPERS
// =============================================================================

/**
 * Consume a syscall stream expecting a single value response.
 *
 * For syscalls that return a single 'ok' response with a value.
 *
 * @param stream - AsyncIterable from syscall()
 * @returns The unwrapped data from the 'ok' response
 * @throws Typed HAL error if syscall returns 'error'
 */
async function unwrap<T>(stream: AsyncIterable<Response>): Promise<T> {
    for await (const r of stream) {
        if (r.op === 'ok') {
            return r.data as T;
        }

        if (r.op === 'error') {
            const err = r.data as { code: string; message: string };

            throw fromCode(err.code, err.message);
        }

        // Any other response type is a bug (kernel/wrapper mismatch)
        throw new Error(`Unexpected response op '${r.op}' for single-value syscall`);
    }

    throw new Error('Unexpected end of syscall stream');
}

/**
 * Consume a syscall stream expecting a void response.
 *
 * For syscalls that return 'ok' with no meaningful value.
 *
 * @param stream - AsyncIterable from syscall()
 * @throws Typed HAL error if syscall returns 'error'
 */
async function unwrapVoid(stream: AsyncIterable<Response>): Promise<void> {
    for await (const r of stream) {
        if (r.op === 'ok') {
            return;
        }

        if (r.op === 'error') {
            const err = r.data as { code: string; message: string };

            throw fromCode(err.code, err.message);
        }

        // Any other response type is a bug (kernel/wrapper mismatch)
        throw new Error(`Unexpected response op '${r.op}' for void syscall`);
    }

    throw new Error('Unexpected end of syscall stream');
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

/**
 * Re-export error types for convenience.
 *
 * WHY: Single import point for all process-related types.
 */
export * from './errors.js';

/**
 * Re-export signal registration.
 */
export { onSignal } from './syscall.js';

/**
 * Re-export channel API.
 */
export { channel, httpRequest, sqlQuery, sqlExecute } from './channel.js';
export type { ChannelOpts, HttpRequest } from './channel.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Open flags for file operations.
 *
 * Matches POSIX open() semantics with boolean flags for clarity.
 */
export interface OpenFlags {
    /** Open for reading */
    read?: boolean;
    /** Open for writing */
    write?: boolean;
    /** Create if doesn't exist */
    create?: boolean;
    /** Truncate to zero length */
    truncate?: boolean;
    /** Append to end on write */
    append?: boolean;
}

/**
 * Seek reference point.
 */
export type SeekWhence = 'start' | 'current' | 'end';

/**
 * File metadata structure.
 *
 * Returned by stat() and fstat().
 */
export interface Stat {
    /** Entity UUID */
    id: string;
    /** Model type (file, folder, device, etc.) */
    model: string;
    /** Entity name (not full path) */
    name: string;
    /** Parent folder UUID (null for root) */
    parent: string | null;
    /** Owner UUID */
    owner: string;
    /** Size in bytes */
    size: number;
    /** Last modification time */
    mtime: Date;
    /** Creation time */
    ctime: Date;
}

/**
 * Spawn options for child processes.
 */
export interface SpawnOpts {
    /** Command-line arguments (argv) */
    args?: string[];
    /** Working directory */
    cwd?: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Stdin: fd number or 'pipe' for new pipe */
    stdin?: number | 'pipe';
    /** Stdout: fd number or 'pipe' for new pipe */
    stdout?: number | 'pipe';
    /** Stderr: fd number or 'pipe' for new pipe */
    stderr?: number | 'pipe';
}

/**
 * Exit status from wait().
 */
export interface ExitStatus {
    /** Process ID */
    pid: number;
    /** Exit code */
    code: number;
}

/**
 * Message received from a port.
 */
export interface PortMessage {
    /** Sender identifier */
    from: string;
    /** File descriptor (for tcp:listen accept) */
    fd?: number;
    /** Message data */
    data?: Uint8Array;
    /** Additional metadata */
    meta?: Record<string, unknown>;
}

/**
 * TCP listen options.
 */
export interface TcpListenOpts {
    /** Port number to listen on (ignored if unix is set) */
    port: number;
    /** Host to bind to (default: all interfaces) */
    host?: string;
    /** Connection backlog size */
    backlog?: number;
    /** Unix socket path (if set, port/host are ignored) */
    unix?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * SIGTERM signal number.
 *
 * WHY 15: Standard Unix signal for graceful termination request.
 */
export const SIGTERM = 15;

/**
 * SIGKILL signal number.
 *
 * WHY 9: Standard Unix signal for immediate termination.
 * NOTE: SIGKILL is never delivered to process - kernel terminates immediately.
 */
export const SIGKILL = 9;

// =============================================================================
// FILE OPERATIONS
// =============================================================================

/**
 * Open a file.
 *
 * Returns a file descriptor for subsequent I/O operations.
 * The fd is valid until close() is called.
 *
 * @param path - File path (absolute or relative to cwd)
 * @param flags - Open flags (default: { read: true })
 * @returns File descriptor (number)
 * @throws ENOENT - If file doesn't exist and create not set
 * @throws EACCES - If permission denied
 *
 * @example
 * const fd = await open('/etc/passwd');
 * const data = await read(fd);
 * await close(fd);
 */
export function open(path: string, flags?: OpenFlags): Promise<number> {
    return unwrap<number>(syscall('file:open', path, flags ?? { read: true }));
}

/**
 * Close a file descriptor.
 *
 * Releases kernel-side resources. Safe to call multiple times.
 *
 * @param fd - File descriptor from open()
 * @throws EBADF - If fd is invalid
 */
export function close(fd: number): Promise<void> {
    return unwrapVoid(syscall('file:close', fd));
}

/**
 * Read from a file descriptor.
 *
 * Reads bytes from current position. Returns empty Uint8Array at EOF.
 * This is a streaming syscall - it yields data chunks until done.
 *
 * @param fd - File descriptor
 * @param size - Chunk size hint (optional)
 * @returns AsyncIterable of byte chunks
 * @throws EBADF - If fd is invalid
 * @throws EACCES - If not opened for reading
 */
export async function* read(fd: number, size?: number): AsyncIterable<Uint8Array> {
    for await (const r of syscall('file:read', fd, size)) {
        if (r.op === 'data' && r.bytes) {
            yield r.bytes;
        }
        else if (r.op === 'done') {
            return;
        }
        else if (r.op === 'error') {
            const err = r.data as { code: string; message: string };

            throw fromCode(err.code, err.message);
        }
    }
}

/**
 * Write to a file descriptor.
 *
 * Writes data at current position (or end if append mode).
 *
 * @param fd - File descriptor
 * @param data - Data to write
 * @returns Bytes written
 * @throws EBADF - If fd is invalid
 * @throws EACCES - If not opened for writing
 * @throws ENOSPC - If storage quota exceeded
 */
export function write(fd: number, data: Uint8Array): Promise<number> {
    return unwrap<number>(syscall('file:write', fd, data));
}

/**
 * Seek to position in file.
 *
 * @param fd - File descriptor
 * @param offset - Byte offset from whence
 * @param whence - Reference point (default: 'start')
 * @returns New absolute position
 * @throws EBADF - If fd is invalid
 * @throws EINVAL - If resulting position would be negative
 */
export function seek(fd: number, offset: number, whence?: SeekWhence): Promise<number> {
    return unwrap<number>(syscall('file:seek', fd, offset, whence ?? 'start'));
}

/**
 * Get file metadata by path.
 *
 * @param path - File path
 * @returns Stat structure
 * @throws ENOENT - If file doesn't exist
 */
export function stat(path: string): Promise<Stat> {
    return unwrap<Stat>(syscall('file:stat', path));
}

/**
 * Get file metadata by descriptor.
 *
 * @param fd - File descriptor
 * @returns Stat structure
 * @throws EBADF - If fd is invalid
 */
export function fstat(fd: number): Promise<Stat> {
    return unwrap<Stat>(syscall('file:fstat', fd));
}

/**
 * Create a directory.
 *
 * @param path - Directory path
 * @param opts - Options (recursive for mkdir -p behavior)
 * @throws EEXIST - If directory exists
 * @throws ENOENT - If parent doesn't exist (without recursive)
 */
export interface MkdirOpts {
    /** Create parent directories as needed (like mkdir -p) */
    recursive?: boolean;
}

export function mkdir(path: string, opts?: MkdirOpts): Promise<void> {
    return unwrapVoid(syscall('file:mkdir', path, opts));
}

/**
 * Delete a file.
 *
 * @param path - File path
 * @throws ENOENT - If file doesn't exist
 * @throws EISDIR - If path is a directory
 */
export function unlink(path: string): Promise<void> {
    return unwrapVoid(syscall('file:unlink', path));
}

/**
 * Delete a directory.
 *
 * @param path - Directory path
 * @throws ENOENT - If directory doesn't exist
 * @throws ENOTEMPTY - If directory not empty
 */
export function rmdir(path: string): Promise<void> {
    return unwrapVoid(syscall('file:rmdir', path));
}

/**
 * List directory contents.
 *
 * This is a streaming syscall - it yields entry names until done.
 *
 * @param path - Directory path
 * @returns AsyncIterable of entry names
 * @throws ENOENT - If directory doesn't exist
 * @throws ENOTDIR - If path is not a directory
 */
export async function* readdir(path: string): AsyncIterable<string> {
    for await (const r of syscall('file:readdir', path)) {
        if (r.op === 'item') {
            yield r.data as string;
        }
        else if (r.op === 'done') {
            return;
        }
        else if (r.op === 'error') {
            const err = r.data as { code: string; message: string };

            throw fromCode(err.code, err.message);
        }
    }
}

/**
 * Rename/move a file or directory.
 *
 * @param oldPath - Current path
 * @param newPath - New path
 * @throws ENOENT - If source doesn't exist
 */
export function rename(oldPath: string, newPath: string): Promise<void> {
    return unwrapVoid(syscall('file:rename', oldPath, newPath));
}

// =============================================================================
// ACCESS CONTROL (ACL)
// =============================================================================

/**
 * Permission grant.
 */
export interface Grant {
    /** Who receives the grant (caller ID, or '*' for everyone) */
    to: string;
    /** What operations are permitted (e.g., 'read', 'write', '*') */
    ops: string[];
    /** Optional expiration (ms since epoch) */
    expires?: number;
}

/**
 * Access Control List.
 */
export interface ACL {
    /** Explicit grants */
    grants: Grant[];
    /** Explicit denies (caller IDs) - always wins over grants */
    deny: string[];
}

/**
 * Get or set ACL for a path.
 *
 * This is the unified API for permission management. It replaces the need for
 * separate grant()/revoke()/chmod() syscalls by providing direct ACL access.
 *
 * @param path - File or directory path
 * @returns Current ACL when called with path only
 *
 * @example
 * // Get current ACL
 * const acl = await access('/myfile');
 *
 * // Grant world read access
 * await access('/myfile', {
 *     grants: [{ to: '*', ops: ['read'] }],
 *     deny: []
 * });
 *
 * // Reset to default (owner-only)
 * await access('/myfile', null);
 */
export function access(path: string): Promise<ACL>;
/**
 * Set ACL for a path.
 *
 * @param path - File or directory path
 * @param acl - New ACL, or null to reset to default (owner-only)
 */
export function access(path: string, acl: ACL | null): Promise<void>;
export function access(path: string, acl?: ACL | null): Promise<ACL | void> {
    if (acl === undefined) {
        return unwrap<ACL>(syscall('file:access', path));
    }

    return unwrapVoid(syscall('file:access', path, acl));
}

// =============================================================================
// PIPE OPERATIONS
// =============================================================================

/**
 * Create a pipe.
 *
 * Returns [readFd, writeFd] - a unidirectional data channel.
 * Data written to writeFd can be read from readFd.
 * Closing writeFd signals EOF to readers.
 *
 * @returns Tuple of [readFd, writeFd]
 *
 * @example
 * const [readFd, writeFd] = await pipe();
 * await write(writeFd, new TextEncoder().encode('hello'));
 * await close(writeFd);
 * const data = await read(readFd);
 */
export function pipe(): Promise<[number, number]> {
    return unwrap<[number, number]>(syscall('ipc:pipe'));
}

/**
 * Redirect a file descriptor to another.
 *
 * Returns a restore function that reverts the redirection when called.
 * This is useful for temporarily redirecting stdout/stderr to a file.
 *
 * @param targetFd - The fd to redirect (e.g., 1 for stdout)
 * @param sourceFd - The fd to redirect to (e.g., a file fd)
 * @returns A function that restores the original fd when called
 *
 * @example
 * const fd = await open('/tmp/output.txt', { write: true, create: true });
 * const restore = await redirect(1, fd);  // stdout → file
 * await println('This goes to file');
 * await restore();  // stdout → console
 * await close(fd);
 */
export async function redirect(targetFd: number, sourceFd: number): Promise<() => Promise<void>> {
    const saved = await unwrap<string>(syscall('redirect', { target: targetFd, source: sourceFd }));

    return async () => {
        await unwrapVoid(syscall('restore', { target: targetFd, saved }));
    };
}

// =============================================================================
// NETWORK OPERATIONS
// =============================================================================

/**
 * Connect to a TCP host.
 *
 * @param host - Hostname or IP address
 * @param port - Port number
 * @returns File descriptor for the connection
 * @throws ECONNREFUSED - If connection refused
 * @throws ETIMEDOUT - If connection timed out
 */
export function connect(host: string, port: number): Promise<number> {
    return unwrap<number>(syscall('net:connect', 'tcp', host, port));
}

// =============================================================================
// PORT OPERATIONS
// =============================================================================

/**
 * Create a TCP listener port.
 *
 * Ports are like file descriptors but for message-based I/O.
 * Use recv() to accept connections.
 *
 * @param opts - Listen options
 * @returns Port ID
 * @throws EADDRINUSE - If port already in use
 */
export function listen(opts: TcpListenOpts): Promise<number> {
    return unwrap<number>(syscall('port:create', 'tcp:listen', opts));
}

/**
 * Receive a message from a port.
 *
 * Blocks until a message is available.
 * For tcp:listen ports, returns { from, fd } where fd is the accepted connection.
 *
 * @param portId - Port ID from listen()
 * @returns Port message
 * @throws EBADF - If port is closed
 */
export function recv(portId: number): Promise<PortMessage> {
    return unwrap<PortMessage>(syscall('port:recv', portId));
}

/**
 * Send a message on a port.
 *
 * @param portId - Port ID
 * @param to - Destination identifier
 * @param data - Data to send
 */
export function send(portId: number, to: string, data: Uint8Array): Promise<void> {
    return unwrapVoid(syscall('port:send', portId, to, data));
}

/**
 * Close a port.
 *
 * @param portId - Port ID
 */
export function pclose(portId: number): Promise<void> {
    return unwrapVoid(syscall('port:close', portId));
}

// =============================================================================
// PROCESS OPERATIONS
// =============================================================================

/**
 * Spawn a child process.
 *
 * @param entry - Entry point path (e.g., '/bin/ls')
 * @param opts - Spawn options
 * @returns Child PID
 *
 * @example
 * const pid = await spawn('/bin/echo', {
 *     args: ['hello', 'world'],
 *     stdout: 1  // inherit parent's stdout
 * });
 * const status = await wait(pid);
 */
export function spawn(entry: string, opts?: SpawnOpts): Promise<number> {
    return unwrap<number>(syscall('proc:spawn', entry, opts));
}

/**
 * Exit the current process.
 *
 * This function never returns - the process terminates immediately.
 *
 * @param code - Exit code (0 = success, non-zero = failure)
 */
export async function exit(code: number): Promise<never> {
    // exit syscall never returns - process terminates
    for await (const r of syscall('proc:exit', code)) {
        if (r.op === 'error') {
            const err = r.data as { code: string; message: string };

            throw fromCode(err.code, err.message);
        }
    }

    // This should never be reached
    throw new Error('exit() returned unexpectedly');
}

/**
 * Send a signal to a process.
 *
 * @param pid - Process ID
 * @param signal - Signal number (default: SIGTERM)
 * @throws ESRCH - If process doesn't exist
 * @throws EPERM - If not permitted to signal process
 */
export function kill(pid: number, signal?: number): Promise<void> {
    return unwrapVoid(syscall('proc:kill', pid, signal ?? SIGTERM));
}

/**
 * Wait for a child process to exit.
 *
 * Blocks until the specified child process exits.
 *
 * @param pid - Child PID
 * @returns Exit status
 * @throws ECHILD - If not a child of this process
 */
export function wait(pid: number): Promise<ExitStatus> {
    return unwrap<ExitStatus>(syscall('proc:wait', pid));
}

/**
 * Get current process ID.
 *
 * @returns PID
 */
export function getpid(): Promise<number> {
    return unwrap<number>(syscall('proc:getpid'));
}

/**
 * Get parent process ID.
 *
 * @returns Parent PID
 */
export function getppid(): Promise<number> {
    return unwrap<number>(syscall('proc:getppid'));
}

/**
 * Get command-line arguments.
 *
 * @returns Argument array (argv[0] is the command)
 */
export function getargs(): Promise<string[]> {
    return unwrap<string[]>(syscall('proc:getargs'));
}

// =============================================================================
// ENVIRONMENT OPERATIONS
// =============================================================================

/**
 * Get current working directory.
 *
 * @returns Directory path
 */
export function getcwd(): Promise<string> {
    return unwrap<string>(syscall('proc:getcwd'));
}

/**
 * Change current working directory.
 *
 * @param path - New directory path
 * @throws ENOENT - If directory doesn't exist
 * @throws ENOTDIR - If path is not a directory
 */
export function chdir(path: string): Promise<void> {
    return unwrapVoid(syscall('proc:chdir', path));
}

/**
 * Get environment variable.
 *
 * @param name - Variable name
 * @returns Value or undefined if not set
 */
export function getenv(name: string): Promise<string | undefined> {
    return unwrap<string | undefined>(syscall('proc:getenv', name));
}

/**
 * Set environment variable.
 *
 * @param name - Variable name
 * @param value - Value to set
 */
export function setenv(name: string, value: string): Promise<void> {
    return unwrapVoid(syscall('proc:setenv', name, value));
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Read entire file as string.
 *
 * Opens file, reads all content, closes file, returns as UTF-8 string.
 *
 * @param path - File path
 * @returns File contents as UTF-8 string
 * @throws ENOENT - If file doesn't exist
 *
 * @example
 * const content = await readFile('/etc/passwd');
 */
export async function readFile(path: string): Promise<string> {
    const fd = await open(path, { read: true });

    try {
        const chunks: Uint8Array[] = [];

        for await (const chunk of read(fd)) {
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
    }
    finally {
        await close(fd);
    }
}

/**
 * Write string to file.
 *
 * Opens file (creating if needed), writes content, closes file.
 *
 * @param path - File path
 * @param content - Content to write
 *
 * @example
 * await writeFile('/tmp/hello.txt', 'Hello, World!');
 */
export async function writeFile(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, truncate: true });

    try {
        await write(fd, new TextEncoder().encode(content));
    }
    finally {
        await close(fd);
    }
}

/**
 * Write to stdout (fd 1).
 *
 * @param text - Text to write
 */
export async function print(text: string): Promise<void> {
    await write(1, new TextEncoder().encode(text));
}

/**
 * Write to stdout with newline.
 *
 * @param text - Text to write
 */
export async function println(text: string): Promise<void> {
    await write(1, new TextEncoder().encode(text + '\n'));
}

/**
 * Write to stderr (fd 2).
 *
 * @param text - Text to write
 */
export async function eprint(text: string): Promise<void> {
    await write(2, new TextEncoder().encode(text));
}

/**
 * Write to stderr with newline.
 *
 * @param text - Text to write
 */
export async function eprintln(text: string): Promise<void> {
    await write(2, new TextEncoder().encode(text + '\n'));
}

/**
 * Sleep for a duration.
 *
 * NOTE: This uses setTimeout, not a syscall. The kernel is not involved.
 *
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
