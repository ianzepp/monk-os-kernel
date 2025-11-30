/**
 * Kernel Types
 *
 * Core type definitions for the Monk OS kernel.
 */

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

    /** Open file descriptors: local fd -> resource UUID */
    fds: Map<number, string>;

    /** Open ports: local port id -> port UUID */
    ports: Map<number, string>;

    /** Next fd to allocate */
    nextFd: number;

    /** Next port id to allocate */
    nextPort: number;

    /** Exit code (when state = 'zombie') */
    exitCode?: number;

    /** Child PIDs mapped to process UUIDs */
    children: Map<number, string>;

    /** Next PID to assign to children */
    nextPid: number;
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
export const MAX_FDS = 256;
export const MAX_PORTS = 64;

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
 * Message types between kernel and processes
 */
export type KernelMessage = SyscallRequest | SyscallResponse | SignalMessage;

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
}
