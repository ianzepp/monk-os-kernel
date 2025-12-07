/**
 * Router Types - Interfaces for the syscall routing layer
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines the interfaces that connect the Router to the Kernel.
 * The Router handles message parsing, dispatch, streaming, and backpressure.
 * The Kernel implements KernelOps to provide the actual syscall behavior.
 *
 * The KernelOps interface uses literal method names that match syscall names
 * (e.g., 'file:open') for zero-cost dispatch via property lookup.
 *
 * @module router/types
 */

import type { Response } from '../message.js';

// =============================================================================
// DEPENDENCIES
// =============================================================================

/**
 * Injectable dependencies for the Router.
 *
 * TESTABILITY: Inject mock implementations to control time in tests.
 */
export interface RouterDeps {
    /**
     * Get current time in milliseconds.
     * Default: Date.now
     */
    now: () => number;

    /**
     * Schedule a callback after delay.
     * Default: globalThis.setTimeout
     */
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;

    /**
     * Cancel a scheduled callback.
     * Default: globalThis.clearTimeout
     */
    clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => void;
}

// =============================================================================
// PROCESS CONTEXT
// =============================================================================

/**
 * Minimal process context passed to syscall handlers.
 *
 * This is what the kernel sees of a process during syscall execution.
 * The router manages stream state separately.
 */
export interface ProcessContext {
    /** Process UUID */
    id: string;

    /** User identity for ACL checks */
    user: string;

    /** Current working directory */
    cwd: string;

    /** Environment variables */
    env: Record<string, string>;

    /** Command-line arguments */
    args: string[];

    /** Process state */
    state: 'starting' | 'running' | 'stopped' | 'zombie';
}

// =============================================================================
// KERNEL MESSAGE TYPES
// =============================================================================

/**
 * Syscall request from userland.
 */
export interface SyscallRequest {
    type: 'syscall';
    id: string;
    pid: string;
    name: string;
    args: unknown[];
}

/**
 * Stream ping from userland (acknowledges items processed).
 */
export interface StreamPingMessage {
    type: 'stream_ping';
    id: string;
    processed: number;
}

/**
 * Stream cancel from userland (abort stream).
 */
export interface StreamCancelMessage {
    type: 'stream_cancel';
    id: string;
}

/**
 * All message types from userland to kernel.
 */
export type KernelMessage = SyscallRequest | StreamPingMessage | StreamCancelMessage;

// =============================================================================
// OPEN FLAGS
// =============================================================================

/**
 * Flags for file open operations.
 */
export interface OpenFlags {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
}

// =============================================================================
// SPAWN OPTIONS
// =============================================================================

/**
 * Options for spawning a child process.
 */
export interface SpawnOpts {
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: number | 'pipe';
    stdout?: number | 'pipe';
    stderr?: number | 'pipe';
}

// =============================================================================
// KERNEL OPS INTERFACE
// =============================================================================

/**
 * Kernel operations interface.
 *
 * Each method corresponds to a syscall. Method names use literal strings
 * that match syscall names (e.g., 'file:open') for direct lookup dispatch.
 *
 * All methods return AsyncIterable<Response> to support streaming results.
 *
 * DESIGN:
 * - Method name = syscall name (grep-friendly)
 * - File name = syscall name with : → - (e.g., file-open.ts)
 * - Dispatch is O(1): kernel[syscallName](proc, ...args)
 */
export interface KernelOps {
    // =========================================================================
    // PROCESS SYSCALLS
    // =========================================================================

    /** Spawn a child process */
    'proc:spawn'(proc: ProcessContext, entry: string, opts?: SpawnOpts): AsyncIterable<Response>;

    /** Exit the calling process */
    'proc:exit'(proc: ProcessContext, code: number): AsyncIterable<Response>;

    /** Send signal to a process */
    'proc:kill'(proc: ProcessContext, pid: number, signal?: number): AsyncIterable<Response>;

    /** Wait for child process to exit */
    'proc:wait'(proc: ProcessContext, pid: number, timeout?: number): AsyncIterable<Response>;

    /** Get process ID */
    'proc:getpid'(proc: ProcessContext): AsyncIterable<Response>;

    /** Get parent process ID */
    'proc:getppid'(proc: ProcessContext): AsyncIterable<Response>;

    /** Create a virtual process */
    'proc:create'(proc: ProcessContext, opts?: { cwd?: string; env?: Record<string, string> }): AsyncIterable<Response>;

    /** Get command-line arguments */
    'proc:getargs'(proc: ProcessContext): AsyncIterable<Response>;

    /** Get current working directory */
    'proc:getcwd'(proc: ProcessContext): AsyncIterable<Response>;

    /** Change current working directory */
    'proc:chdir'(proc: ProcessContext, path: string): AsyncIterable<Response>;

    /** Get environment variable */
    'proc:getenv'(proc: ProcessContext, name: string): AsyncIterable<Response>;

    /** Set environment variable */
    'proc:setenv'(proc: ProcessContext, name: string, value: string): AsyncIterable<Response>;

    // =========================================================================
    // FILE SYSCALLS
    // =========================================================================

    /** Open a file */
    'file:open'(proc: ProcessContext, path: string, flags?: OpenFlags): AsyncIterable<Response>;

    /** Close a file descriptor */
    'file:close'(proc: ProcessContext, fd: number): AsyncIterable<Response>;

    /** Read from a file descriptor */
    'file:read'(proc: ProcessContext, fd: number, chunkSize?: number): AsyncIterable<Response>;

    /** Write to a file descriptor */
    'file:write'(proc: ProcessContext, fd: number, data: Uint8Array): AsyncIterable<Response>;

    /** Seek in a file */
    'file:seek'(proc: ProcessContext, fd: number, offset: number, whence?: string): AsyncIterable<Response>;

    /** Get file stats by path */
    'file:stat'(proc: ProcessContext, path: string): AsyncIterable<Response>;

    /** Get file stats by descriptor */
    'file:fstat'(proc: ProcessContext, fd: number): AsyncIterable<Response>;

    /** Create a directory */
    'file:mkdir'(proc: ProcessContext, path: string, opts?: { recursive?: boolean }): AsyncIterable<Response>;

    /** Remove a file */
    'file:unlink'(proc: ProcessContext, path: string): AsyncIterable<Response>;

    /** Remove a directory */
    'file:rmdir'(proc: ProcessContext, path: string): AsyncIterable<Response>;

    /** List directory contents */
    'file:readdir'(proc: ProcessContext, path: string): AsyncIterable<Response>;

    /** Rename a file (not implemented) */
    'file:rename'(proc: ProcessContext, oldPath: string, newPath: string): AsyncIterable<Response>;

    /** Create a symbolic link */
    'file:symlink'(proc: ProcessContext, target: string, linkPath: string): AsyncIterable<Response>;

    /** Get or set access control */
    'file:access'(proc: ProcessContext, path: string, acl?: unknown): AsyncIterable<Response>;

    /** Receive messages from fd (message-based I/O) */
    'file:recv'(proc: ProcessContext, fd: number): AsyncIterable<Response>;

    /** Send message to fd (message-based I/O) */
    'file:send'(proc: ProcessContext, fd: number, msg: Response): AsyncIterable<Response>;

    // =========================================================================
    // FILESYSTEM MOUNT SYSCALLS
    // =========================================================================

    /** Mount a filesystem */
    'fs:mount'(proc: ProcessContext, source: string, target: string, opts?: Record<string, unknown>): AsyncIterable<Response>;

    /** Unmount a filesystem */
    'fs:umount'(proc: ProcessContext, target: string): AsyncIterable<Response>;

    // =========================================================================
    // NETWORK SYSCALLS
    // =========================================================================

    /** Connect to a remote endpoint */
    'net:connect'(proc: ProcessContext, proto: string, host: string, port: number): AsyncIterable<Response>;

    // =========================================================================
    // PORT SYSCALLS
    // =========================================================================

    /** Create a port */
    'port:create'(proc: ProcessContext, type: string, opts: unknown): AsyncIterable<Response>;

    /** Close a port */
    'port:close'(proc: ProcessContext, portId: number): AsyncIterable<Response>;

    /** Receive from a port */
    'port:recv'(proc: ProcessContext, portId: number): AsyncIterable<Response>;

    /** Send to a port */
    'port:send'(proc: ProcessContext, portId: number, to: string, data: Uint8Array): AsyncIterable<Response>;

    // =========================================================================
    // CHANNEL SYSCALLS
    // =========================================================================

    /** Open a channel */
    'channel:open'(proc: ProcessContext, proto: string, url: string, opts?: unknown): AsyncIterable<Response>;

    /** Close a channel */
    'channel:close'(proc: ProcessContext, ch: number): AsyncIterable<Response>;

    /** Call through a channel (request/response) */
    'channel:call'(proc: ProcessContext, ch: number, msg: unknown): AsyncIterable<Response>;

    /** Stream through a channel */
    'channel:stream'(proc: ProcessContext, ch: number, msg: unknown): AsyncIterable<Response>;

    /** Push to a channel */
    'channel:push'(proc: ProcessContext, ch: number, response: Response): AsyncIterable<Response>;

    /** Receive from a channel */
    'channel:recv'(proc: ProcessContext, ch: number): AsyncIterable<Response>;

    // =========================================================================
    // IPC SYSCALLS
    // =========================================================================

    /** Create a pipe */
    'ipc:pipe'(proc: ProcessContext): AsyncIterable<Response>;

    // =========================================================================
    // HANDLE SYSCALLS
    // =========================================================================

    /** Redirect a handle */
    'handle:redirect'(proc: ProcessContext, args: { target: number; source: number }): AsyncIterable<Response>;

    /** Restore a handle */
    'handle:restore'(proc: ProcessContext, args: { target: number; saved: string }): AsyncIterable<Response>;

    /** Send through a handle */
    'handle:send'(proc: ProcessContext, h: number, msg: unknown): AsyncIterable<Response>;

    /** Close a handle */
    'handle:close'(proc: ProcessContext, h: number): AsyncIterable<Response>;

    // =========================================================================
    // WORKER POOL SYSCALLS
    // =========================================================================

    /** Lease a worker from pool */
    'pool:lease'(proc: ProcessContext, pool?: string): AsyncIterable<Response>;

    /** Get pool statistics */
    'pool:stats'(): AsyncIterable<Response>;

    /** Load script into worker */
    'worker:load'(proc: ProcessContext, args: { workerId: string; path: string }): AsyncIterable<Response>;

    /** Send message to worker */
    'worker:send'(proc: ProcessContext, args: { workerId: string; msg: unknown }): AsyncIterable<Response>;

    /** Receive from worker */
    'worker:recv'(proc: ProcessContext, workerId: string): AsyncIterable<Response>;

    /** Release worker back to pool */
    'worker:release'(proc: ProcessContext, workerId: string): AsyncIterable<Response>;

    // =========================================================================
    // EMS SYSCALLS
    // =========================================================================

    /** Select entities */
    'ems:select'(proc: ProcessContext, model: string, filter?: Record<string, unknown>): AsyncIterable<Response>;

    /** Create an entity */
    'ems:create'(proc: ProcessContext, model: string, fields: Record<string, unknown>): AsyncIterable<Response>;

    /** Update an entity */
    'ems:update'(proc: ProcessContext, model: string, id: string, changes: Record<string, unknown>): AsyncIterable<Response>;

    /** Delete an entity (soft) */
    'ems:delete'(proc: ProcessContext, model: string, id: string): AsyncIterable<Response>;

    /** Revert a deleted entity */
    'ems:revert'(proc: ProcessContext, model: string, id: string): AsyncIterable<Response>;

    /** Expire an entity (hard delete) */
    'ems:expire'(proc: ProcessContext, model: string, id: string): AsyncIterable<Response>;

    // =========================================================================
    // SERVICE ACTIVATION
    // =========================================================================

    /** Get activation message for service handlers */
    'activation:get'(proc: ProcessContext): AsyncIterable<Response>;
}

/**
 * Type-safe syscall name.
 */
export type SyscallName = keyof KernelOps;
