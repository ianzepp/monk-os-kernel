/**
 * Process Library
 *
 * Userland interface to the kernel. Runs inside Bun Workers and provides
 * typed functions that translate to syscall messages.
 *
 * Usage:
 *   import { open, read, write, spawn, exit } from '@src/process';
 *
 *   const fd = await open('/etc/passwd');
 *   const data = await read(fd);
 *   await close(fd);
 */

import { syscall } from '@src/process/syscall.js';
import { withTypedErrors } from '@src/process/errors.js';

// Re-export error types for convenience
export * from '@src/process/errors.js';

// Re-export signal registration
export { onSignal } from '@src/process/syscall.js';

// Re-export channel API
export { channel, httpRequest, sqlQuery, sqlExecute } from '@src/process/channel.js';
export type { ChannelOpts, HttpRequest } from '@src/process/channel.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Open flags for file operations
 */
export interface OpenFlags {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
}

/**
 * Seek whence values
 */
export type SeekWhence = 'start' | 'current' | 'end';

/**
 * File stat structure
 */
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

/**
 * Spawn options
 */
export interface SpawnOpts {
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: number | 'pipe';
    stdout?: number | 'pipe';
    stderr?: number | 'pipe';
}

/**
 * Exit status from wait()
 */
export interface ExitStatus {
    pid: number;
    code: number;
}

/**
 * Port message
 */
export interface PortMessage {
    from: string;
    fd?: number;
    data?: Uint8Array;
    meta?: Record<string, unknown>;
}

/**
 * TCP listen options
 */
export interface TcpListenOpts {
    port: number;
    host?: string;
    backlog?: number;
}

/**
 * Signal values
 */
export const SIGTERM = 15;
export const SIGKILL = 9;

// ============================================================================
// File Operations
// ============================================================================

/**
 * Open a file.
 *
 * @param path - File path
 * @param flags - Open flags (default: { read: true })
 * @returns File descriptor
 */
export function open(path: string, flags?: OpenFlags): Promise<number> {
    return withTypedErrors(syscall<number>('open', path, flags ?? { read: true }));
}

/**
 * Close a file descriptor.
 *
 * @param fd - File descriptor
 */
export function close(fd: number): Promise<void> {
    return withTypedErrors(syscall<void>('close', fd));
}

/**
 * Read from a file descriptor.
 *
 * @param fd - File descriptor
 * @param size - Maximum bytes to read (optional)
 * @returns Data read
 */
export function read(fd: number, size?: number): Promise<Uint8Array> {
    return withTypedErrors(syscall<Uint8Array>('read', fd, size));
}

/**
 * Write to a file descriptor.
 *
 * @param fd - File descriptor
 * @param data - Data to write
 * @returns Bytes written
 */
export function write(fd: number, data: Uint8Array): Promise<number> {
    return withTypedErrors(syscall<number>('write', fd, data));
}

/**
 * Seek in a file.
 *
 * @param fd - File descriptor
 * @param offset - Byte offset
 * @param whence - Reference point (default: 'start')
 * @returns New position
 */
export function seek(fd: number, offset: number, whence?: SeekWhence): Promise<number> {
    return withTypedErrors(syscall<number>('seek', fd, offset, whence ?? 'start'));
}

/**
 * Get file metadata.
 *
 * @param path - File path
 * @returns Stat structure
 */
export function stat(path: string): Promise<Stat> {
    return withTypedErrors(syscall<Stat>('stat', path));
}

/**
 * Get file metadata from descriptor.
 *
 * @param fd - File descriptor
 * @returns Stat structure
 */
export function fstat(fd: number): Promise<Stat> {
    return withTypedErrors(syscall<Stat>('fstat', fd));
}

/**
 * Create a directory.
 *
 * @param path - Directory path
 */
export interface MkdirOpts {
    /** Create parent directories as needed (like mkdir -p) */
    recursive?: boolean;
}

export function mkdir(path: string, opts?: MkdirOpts): Promise<void> {
    return withTypedErrors(syscall<void>('mkdir', path, opts));
}

/**
 * Delete a file.
 *
 * @param path - File path
 */
export function unlink(path: string): Promise<void> {
    return withTypedErrors(syscall<void>('unlink', path));
}

/**
 * Delete a directory.
 *
 * @param path - Directory path
 */
export function rmdir(path: string): Promise<void> {
    return withTypedErrors(syscall<void>('rmdir', path));
}

/**
 * List directory contents.
 *
 * @param path - Directory path
 * @returns Entry names
 */
export function readdir(path: string): Promise<string[]> {
    return withTypedErrors(syscall<string[]>('readdir', path));
}

/**
 * Rename/move a file.
 *
 * @param oldPath - Current path
 * @param newPath - New path
 */
export function rename(oldPath: string, newPath: string): Promise<void> {
    return withTypedErrors(syscall<void>('rename', oldPath, newPath));
}

// ============================================================================
// Access Control (ACL)
// ============================================================================

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
        return withTypedErrors(syscall<ACL>('access', path));
    }
    return withTypedErrors(syscall<void>('access', path, acl));
}

// ============================================================================
// Pipe Operations
// ============================================================================

/**
 * Create a pipe.
 *
 * Returns [readFd, writeFd] - a unidirectional data channel.
 * Data written to writeFd can be read from readFd.
 * Closing writeFd signals EOF to readers.
 *
 * @returns Tuple of [readFd, writeFd]
 */
export function pipe(): Promise<[number, number]> {
    return withTypedErrors(syscall<[number, number]>('pipe'));
}

/**
 * Redirect a file descriptor to point to the same resource as another fd.
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

/**
 * Connect to a TCP host.
 *
 * @param host - Hostname or IP
 * @param port - Port number
 * @returns File descriptor for the connection
 */
export function connect(host: string, port: number): Promise<number> {
    return withTypedErrors(syscall<number>('connect', 'tcp', host, port));
}

// ============================================================================
// Port Operations
// ============================================================================

/**
 * Create a TCP listener port.
 *
 * @param opts - Listen options
 * @returns Port ID
 */
export function listen(opts: TcpListenOpts): Promise<number> {
    return withTypedErrors(syscall<number>('port', 'tcp:listen', opts));
}

/**
 * Receive a message from a port.
 *
 * Blocks until a message is available.
 * For tcp:listen ports, returns { from, fd } where fd is the accepted connection.
 *
 * @param portId - Port ID
 * @returns Port message
 */
export function recv(portId: number): Promise<PortMessage> {
    return withTypedErrors(syscall<PortMessage>('recv', portId));
}

/**
 * Send a message on a port.
 *
 * @param portId - Port ID
 * @param to - Destination identifier
 * @param data - Data to send
 */
export function send(portId: number, to: string, data: Uint8Array): Promise<void> {
    return withTypedErrors(syscall<void>('send', portId, to, data));
}

/**
 * Close a port.
 *
 * @param portId - Port ID
 */
export function pclose(portId: number): Promise<void> {
    return withTypedErrors(syscall<void>('pclose', portId));
}

// ============================================================================
// Process Operations
// ============================================================================

/**
 * Spawn a child process.
 *
 * @param entry - Entry point path
 * @param opts - Spawn options
 * @returns Child PID
 */
export function spawn(entry: string, opts?: SpawnOpts): Promise<number> {
    return withTypedErrors(syscall<number>('spawn', entry, opts));
}

/**
 * Exit the current process.
 *
 * @param code - Exit code
 */
export function exit(code: number): Promise<never> {
    return syscall<never>('exit', code);
}

/**
 * Send a signal to a process.
 *
 * @param pid - Process ID
 * @param signal - Signal number (default: SIGTERM)
 */
export function kill(pid: number, signal?: number): Promise<void> {
    return withTypedErrors(syscall<void>('kill', pid, signal ?? SIGTERM));
}

/**
 * Wait for a child process to exit.
 *
 * @param pid - Child PID
 * @returns Exit status
 */
export function wait(pid: number): Promise<ExitStatus> {
    return withTypedErrors(syscall<ExitStatus>('wait', pid));
}

/**
 * Get current process ID.
 *
 * @returns PID
 */
export function getpid(): Promise<number> {
    return withTypedErrors(syscall<number>('getpid'));
}

/**
 * Get parent process ID.
 *
 * @returns Parent PID
 */
export function getppid(): Promise<number> {
    return withTypedErrors(syscall<number>('getppid'));
}

/**
 * Get command-line arguments.
 *
 * @returns Argument array (argv[0] is the command)
 */
export function getargs(): Promise<string[]> {
    return withTypedErrors(syscall<string[]>('getargs'));
}

// ============================================================================
// Environment Operations
// ============================================================================

/**
 * Get current working directory.
 *
 * @returns Directory path
 */
export function getcwd(): Promise<string> {
    return withTypedErrors(syscall<string>('getcwd'));
}

/**
 * Change current working directory.
 *
 * @param path - New directory path
 */
export function chdir(path: string): Promise<void> {
    return withTypedErrors(syscall<void>('chdir', path));
}

/**
 * Get environment variable.
 *
 * @param name - Variable name
 * @returns Value or undefined
 */
export function getenv(name: string): Promise<string | undefined> {
    return withTypedErrors(syscall<string | undefined>('getenv', name));
}

/**
 * Set environment variable.
 *
 * @param name - Variable name
 * @param value - Value
 */
export function setenv(name: string, value: string): Promise<void> {
    return withTypedErrors(syscall<void>('setenv', name, value));
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Read entire file as string.
 *
 * @param path - File path
 * @returns File contents as UTF-8 string
 */
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

/**
 * Write string to file.
 *
 * @param path - File path
 * @param content - Content to write
 */
export async function writeFile(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, truncate: true });
    try {
        await write(fd, new TextEncoder().encode(content));
    } finally {
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
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
