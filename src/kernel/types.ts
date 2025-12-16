/**
 * Kernel Types
 *
 * Core type definitions for the Monk OS kernel.
 */

import type { Message, Response } from '@src/message.js';

/**
 * Process state
 */
export type ProcessState = 'starting' | 'running' | 'stopped' | 'zombie';

/**
 * Process structure
 *
 * Represents a running process in the kernel.
 * Processes are Bun Workers providing isolation.
 *
 * VIRTUAL PROCESSES:
 * A virtual process is a process table entry without its own Worker thread.
 * Instead, it shares its creator's Worker. This enables gatewayd to proxy
 * syscalls for external clients, with each client getting isolated state
 * (handles, cwd, env) while sharing gatewayd's Worker for transport.
 *
 * When virtual=true:
 * - worker points to the creator's Worker (for response delivery)
 * - No worker.terminate() on exit (Worker belongs to creator)
 * - Syscalls specify pid explicitly (Worker → Process mapping is N:1)
 */
export interface Process {
    /** Process UUID (internal identity) */
    id: string;

    /** Parent process UUID (empty for init) */
    parent: string;

    /** User identity for ACL checks (e.g., 'root', 'kernel') */
    user: string;

    // =========================================================================
    // AUTH IDENTITY (set by auth:token, cleared on expiry/logout)
    // =========================================================================

    /**
     * Session ID from JWT.
     *
     * WHY: Tracks the current authentication session. Used for:
     * - Future EMS session lookup (Phase 1)
     * - Session revocation tracking
     * - Audit logging
     *
     * INVARIANT: If session is set, user is also set.
     */
    session?: string;

    /**
     * Session expiry timestamp (ms since epoch).
     *
     * WHY: Enables lazy session expiration. Dispatcher checks on each syscall
     * and clears identity if expired.
     *
     * INVARIANT: If expires is set, session is also set.
     */
    expires?: number;

    /**
     * Last EMS session validation timestamp (ms since epoch).
     *
     * WHY: Phase 1+ will revalidate sessions against EMS every 5 minutes.
     * This allows session revocation to propagate without checking EMS
     * on every syscall.
     *
     * INVARIANT: Only set when session is set.
     */
    sessionValidatedAt?: number;

    /**
     * JWT claims or session metadata.
     *
     * WHY: Preserves JWT claims (iat, scope, custom claims) for the session.
     * Avoids re-parsing JWT for subsequent operations.
     *
     * INVARIANT: Only set when session is set.
     */
    sessionData?: {
        /** Issued at timestamp (seconds) */
        iat?: number;
        /** Permission scopes */
        scope?: string[];
        /** Allow additional claims */
        [key: string]: unknown;
    };

    /** Bun Worker instance (shared with creator if virtual=true) */
    worker: Worker;

    /**
     * Whether this is a virtual process (shares parent's Worker).
     *
     * WHY: Enables gatewayd to create isolated process contexts for external
     * clients without spawning new Worker threads.
     *
     * INVARIANT: If virtual=true, worker === parent's worker
     * EFFECT: On exit, don't call worker.terminate() (Worker belongs to creator)
     */
    virtual: boolean;

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

    /**
     * PATH directories as named entries.
     * Key = priority name (e.g., '00-core', '50-httpd'), sorted alphabetically
     * Value = directory path (e.g., '/bin', '/pkg/httpd/bin')
     */
    pathDirs: Map<string, string>;

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
 * Kernel identity constant
 *
 * Used as a magic identity for:
 * - VFS caller identity (ACL bypass)
 * - File ownership
 * - Process identity (kernel process is PID 1)
 * - Mount policy rules
 */
export const KERNEL_ID = 'kernel';

/**
 * Signal values
 */
export const SIGTERM = 15;
export const SIGKILL = 9;
export const SIGTICK = 30;

/**
 * Default tick interval (ms)
 */
export const TICK_INTERVAL_MS = 1000;

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
 *
 * VIRTUAL PROCESS SUPPORT:
 * The `pid` field identifies which process context to use for execution.
 * This enables a single Worker to make syscalls on behalf of multiple
 * virtual processes (each with isolated handles, cwd, env).
 *
 * The kernel validates that the message came from the correct Worker:
 * - Look up process by pid
 * - Verify proc.worker === messageSourceWorker
 *
 * For regular processes, pid matches the Worker's process.
 * For virtual processes, pid identifies the virtual process, and
 * Worker matches the creator's Worker.
 */
export interface SyscallRequest {
    type: 'syscall:request';
    /** Request correlation ID (for response matching) */
    id: string;
    /**
     * Process ID making the syscall.
     *
     * WHY REQUIRED: Enables virtual processes where multiple process contexts
     * share a single Worker thread. The kernel uses pid to look up process
     * context (handles, cwd, env) and validates the Worker matches.
     */
    pid: string;
    /** Syscall name (e.g., 'file:open', 'proc:spawn') */
    name: string;
    /** Syscall arguments */
    args: unknown[];
}

/**
 * Syscall response from kernel to process
 */
export interface SyscallResponse {
    type: 'syscall:response';
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
    payload?: unknown;
}

/**
 * Tick signal payload
 */
export interface TickPayload {
    /** Milliseconds since last tick */
    dt: number;
    /** Current timestamp (Date.now()) */
    now: number;
    /** Monotonic tick sequence number */
    seq: number;
}

/**
 * Stream ping message from userspace to kernel (progress report)
 */
export interface StreamPingMessage {
    type: 'syscall:ping';
    id: string;
    /** Number of items consumer has processed */
    processed: number;
}

/**
 * Stream cancel message from userspace to kernel (stop producing, cleanup)
 */
export interface StreamCancelMessage {
    type: 'syscall:cancel';
    id: string;
}

/**
 * Sigcall request from kernel to userspace handler.
 *
 * Sent when a process invokes a syscall that's registered
 * in the sigcall registry.
 */
export interface SigcallRequest {
    type: 'sigcall:request';
    /** Request correlation ID */
    id: string;
    /** Sigcall name (e.g., 'window:create') */
    name: string;
    /** Handler arguments */
    args: unknown[];
    /** Caller information */
    caller?: {
        /** Calling process ID */
        pid?: string;
        /** Gateway connection ID (for push responses) */
        connId?: string;
    };
}

/**
 * Sigcall response from userspace handler to kernel.
 */
export interface SigcallResponse {
    type: 'sigcall:response';
    /** Request correlation ID (matches request) */
    id: string;
    /** Response payload */
    result: Response;
}

/**
 * Message types between kernel and processes
 */
export type KernelMessage =
    | SyscallRequest
    | SyscallResponse
    | SignalMessage
    | StreamPingMessage
    | StreamCancelMessage
    | SigcallRequest
    | SigcallResponse;

/**
 * Port message delivered to a process's port.
 *
 * Ports provide async event delivery from I/O sources. When an event occurs
 * (TCP connection accepted, UDP packet received, file change detected), the
 * kernel creates a ProcessPortMessage and posts it to the process's worker.
 *
 * WHY union of fd/data/meta:
 * Different event types carry different payloads. TCP accepts return a file
 * descriptor for the new connection. UDP/pubsub/watch return data bytes.
 * The discriminated union avoids runtime type checks.
 *
 * INVARIANT: Exactly one of fd, data, or meta.data must be present.
 */
export interface ProcessPortMessage {
    /**
     * Source identifier for the event.
     * Format: "{protocol}:{address}" (e.g., "tcp:3000", "udp:8080", "watch:/etc")
     */
    from: string;

    /** File descriptor for accepted TCP connections (tcp:listen ports only) */
    fd?: number;

    /** Payload data for UDP, pubsub, and watch events */
    data?: Uint8Array;

    /** Optional metadata for events */
    meta?: Record<string, unknown>;
}

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
    | 'udp:bind'
    | 'fs:watch'
    | 'pubsub:subscribe'
    | 'signal:catch'
    | 'proc:watch';

/**
 * Port options by type
 */
export interface PortOpts {
    'tcp:listen': { port: number; host?: string; backlog?: number };
    'udp:bind': { port: number; host?: string };
    'fs:watch': { pattern: string };
    'pubsub:subscribe': { topics: string[] };
    'signal:catch': { signals: ('TERM')[] };
    'proc:watch': { scope: 'children' | 'all' };
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

}
