/**
 * Kernel Types
 *
 * Core type definitions for the Monk OS kernel.
 */

import type { Message } from '@src/message.js';

/**
 * Process state
 */
export type ProcessState = 'starting' | 'running' | 'stopped' | 'zombie';

/**
 * Process structure
 *
 * Represents a running process in the kernel.
 * Processes are Bun Workers providing isolation.
 */
export interface Process {
    /** Process UUID (internal identity) */
    id: string;

    /** Parent process UUID (empty for init) */
    parent: string;

    /** Bun Worker instance */
    worker: Worker;

    /** Current state */
    state: ProcessState;

    /** Entry point / command */
    cmd: string;

    /** Working directory */
    cwd: string;

    /** Environment variables */
    env: Record<string, string>;

    /** Command-line arguments */
    args: string[];

    /** Open handles: local handle id -> handle UUID */
    handles: Map<number, string>;

    /** Next handle id to allocate (starts at 3, after stdio) */
    nextHandle: number;

    /** Exit code (when state = 'zombie') */
    exitCode?: number;

    /** Child PIDs mapped to process UUIDs */
    children: Map<number, string>;

    /** Next PID to assign to children */
    nextPid: number;

    /** Active streaming syscalls: request id -> abort controller */
    activeStreams: Map<string, AbortController>;

    /** Ping handlers for active streams: request id -> handler(processed) */
    streamPingHandlers: Map<string, (processed: number) => void>;

    /** Activation message for service handlers (set by kernel on spawn) */
    activationMessage?: Message;
}

/**
 * Spawn options
 */
export interface SpawnOpts {
    /** Command-line arguments */
    args?: string[];

    /** Working directory for child */
    cwd?: string;

    /** Environment variables (merged with parent) */
    env?: Record<string, string>;

    /** Stdin fd to inherit (or 'pipe' for new pipe) */
    stdin?: number | 'pipe';

    /** Stdout fd to inherit (or 'pipe' for new pipe) */
    stdout?: number | 'pipe';

    /** Stderr fd to inherit (or 'pipe' for new pipe) */
    stderr?: number | 'pipe';
}

/**
 * Exit status returned by wait()
 */
export interface ExitStatus {
    /** Process ID that exited */
    pid: number;

    /** Exit code */
    code: number;
}

/**
 * Options for spawning a process from the host (external to kernel)
 */
export interface ExternalSpawnOpts {
    /** Command-line arguments */
    args?: string[];

    /** Working directory */
    cwd?: string;

    /** Environment variables */
    env?: Record<string, string>;
}

/**
 * Handle to a process spawned from outside the kernel.
 *
 * Provides the minimal interface needed for the host (OS layer) to
 * manage kernel processes.
 */
export interface ExternalProcessHandle {
    /** Process UUID */
    id: string;

    /** Send a signal to the process */
    kill(signal?: number): Promise<void>;

    /** Wait for the process to exit */
    wait(): Promise<{ code: number }>;
}

/**
 * Signal values
 */
export const SIGTERM = 15;
export const SIGKILL = 9;

/**
 * Grace period for SIGTERM before SIGKILL (ms)
 */
export const TERM_GRACE_MS = 5000;

/**
 * Resource limits per process
 */
export const MAX_HANDLES = 256;  // Unified limit for all handle types

/**
 * File I/O streaming constants
 */
export const DEFAULT_CHUNK_SIZE = 65536;        // 64KB default chunk size
export const MAX_STREAM_BYTES = 100 * 1024 * 1024;  // 100MB hard cap per read stream
export const MAX_STREAM_ENTRIES = 100_000;      // 100k entries hard cap for readdir

/**
 * Stream backpressure thresholds
 *
 * TODO: These are item-count based, but memory pressure depends on message size.
 * A stream of 1000 small integers uses far less memory than 1000 1MB chunks.
 * Consider switching to byte-based thresholds:
 *   - HIGH_WATER = 64KB, LOW_WATER = 8KB
 *   - Track bytesSent/bytesAcked instead of item counts
 *   - Ping reports bytesProcessed
 *   - estimateSize(data): Uint8Array.length, string.length*2, JSON.stringify for objects
 */
export const STREAM_HIGH_WATER = 1000; // Pause when this many items unacked
export const STREAM_LOW_WATER = 100;   // Resume when gap falls to this
export const STREAM_PING_INTERVAL = 100; // Consumer pings every 100ms
export const STREAM_STALL_TIMEOUT = 5000; // Abort if no ping for this long

/**
 * Syscall message from process to kernel
 */
export interface SyscallRequest {
    type: 'syscall';
    id: string;
    name: string;
    args: unknown[];
}

/**
 * Syscall response from kernel to process
 */
export interface SyscallResponse {
    type: 'response';
    id: string;
    result?: unknown;
    error?: {
        code: string;
        message: string;
    };
}

/**
 * Signal message from kernel to process
 */
export interface SignalMessage {
    type: 'signal';
    signal: number;
}

/**
 * Stream ping message from userspace to kernel (progress report)
 */
export interface StreamPingMessage {
    type: 'stream_ping';
    id: string;
    /** Number of items consumer has processed */
    processed: number;
}

/**
 * Stream cancel message from userspace to kernel (stop producing, cleanup)
 */
export interface StreamCancelMessage {
    type: 'stream_cancel';
    id: string;
}

/**
 * Message types between kernel and processes
 */
export type KernelMessage =
    | SyscallRequest
    | SyscallResponse
    | SignalMessage
    | StreamPingMessage
    | StreamCancelMessage;

/**
 * File stat structure
 */
export interface Stat {
    /** Entity UUID */
    id: string;

    /** Model type (file, folder, device, etc.) */
    model: string;

    /** Name */
    name: string;

    /** Parent UUID */
    parent: string | null;

    /** Owner UUID */
    owner: string;

    /** Size in bytes */
    size: number;

    /** Modification time */
    mtime: Date;

    /** Creation time */
    ctime: Date;
}

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
 * Seek whence values (matches VFS)
 */
export type SeekWhence = 'start' | 'current' | 'end';

/**
 * Port types
 */
export type PortType =
    | 'tcp:listen'
    | 'udp'
    | 'watch'
    | 'pubsub'
    | 'signal'
    | 'process';

/**
 * Port options by type
 */
export interface PortOpts {
    'tcp:listen': { port: number; host?: string; backlog?: number };
    'udp': { bind: number };
    'watch': { pattern: string };
    'pubsub': { subscribe: string[] };
    'signal': { catch: ('TERM')[] };
    'process': { watch: 'children' | 'all' };
}

/**
 * Message received on a port
 */
export interface PortMessage {
    /** Source identifier */
    from: string;

    /** Message data */
    data: unknown;
}

/**
 * Kernel boot environment
 */
export interface BootEnv {
    /** Path to init process */
    initPath: string;

    /** Command-line arguments for init */
    initArgs?: string[];

    /** Initial environment variables */
    env?: Record<string, string>;

    /** Enable kernel debug logging (printk) */
    debug?: boolean;

    /**
     * Path to ROM directory on host filesystem.
     *
     * The ROM contains bundled userspace code that is copied into VFS at boot.
     * Defaults to './rom' if not specified.
     *
     * WHY CONFIGURABLE: Allows different ROMs for:
     * - Testing (minimal ROM with test fixtures)
     * - Production (full ROM with signed binaries)
     * - Development (ROM with debug symbols)
     */
    romPath?: string;
}
