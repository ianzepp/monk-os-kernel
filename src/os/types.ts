/**
 * OS Types
 *
 * Shared interfaces for the OS public API.
 */

import type { HAL } from '@src/hal/index.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { Kernel } from '@src/kernel/kernel.js';

// ============================================================================
// Lifecycle Events
// ============================================================================

/**
 * OS lifecycle event callbacks.
 *
 * Register with `os.on(event, callback)` to hook into boot sequence.
 * Callbacks are invoked during `boot()` at the appropriate stage,
 * before init process is spawned.
 */
export interface OSEvents {
    /**
     * Called after HAL is created and initialized.
     * Use to configure HAL features before VFS/Kernel creation.
     */
    hal: (hal: HAL) => void | Promise<void>;

    /**
     * Called after VFS is created and initialized.
     * Use to configure mounts, filesystem settings before kernel.
     */
    vfs: (vfs: VFS) => void | Promise<void>;

    /**
     * Called after Kernel is created.
     * Use to register services, configure kernel before init spawns.
     */
    kernel: (kernel: Kernel) => void | Promise<void>;

    /**
     * Called after init process has been spawned (if any).
     * OS is fully booted and ready.
     */
    boot: () => void | Promise<void>;

    /**
     * Called during shutdown, before subsystems are torn down.
     * Use for cleanup.
     */
    shutdown: () => void | Promise<void>;
}

/**
 * Valid lifecycle event names.
 */
export type OSEventName = keyof OSEvents;

/**
 * Storage configuration for the OS
 */
export interface StorageConfig {
    type: 'memory' | 'sqlite' | 'postgres';
    url?: string;
    path?: string;
}

/**
 * OS configuration options
 */
export interface OSConfig {
    /**
     * Path aliases for convenient referencing.
     * Maps alias names (e.g., '@app') to OS paths (e.g., '/vol/app').
     */
    aliases?: Record<string, string>;

    /**
     * Storage backend configuration.
     * Defaults to in-memory storage.
     */
    storage?: StorageConfig;

    /**
     * Environment variables available to all processes.
     */
    env?: Record<string, string>;
}

/**
 * Boot options
 */
export interface BootOpts {
    /**
     * Path to init script (inside OS).
     * If provided, spawns this as PID 1.
     */
    main?: string;

    /**
     * Enable kernel debug logging (printk).
     */
    debug?: boolean;
}

/**
 * Exec options for takeover mode
 */
export interface ExecOpts {
    /**
     * Path to init script (inside OS).
     * Required for exec() takeover mode.
     */
    main: string;

    /**
     * Enable kernel debug logging (printk).
     */
    debug?: boolean;
}

/**
 * Mount options for host filesystem mounts
 */
export interface MountOpts {
    /** Mount as read-only */
    readonly?: boolean;
    /** Watch for changes (future: hot reload) */
    watch?: boolean;
}

/**
 * File/directory stat information
 */
export interface Stat {
    /** Entity ID */
    id: string;
    /** Entity type */
    type: 'file' | 'folder' | 'device' | 'link';
    /** Name */
    name: string;
    /** Size in bytes */
    size: number;
    /** Last modified time (ms since epoch) */
    mtime: number;
    /** Created time (ms since epoch) */
    ctime: number;
}

// ============================================================================
// Process API Types
// ============================================================================

/**
 * Options for spawning a process
 */
export interface SpawnOpts {
    /** Command-line arguments */
    args?: string[];
    /** Environment variables */
    env?: Record<string, string>;
    /** Working directory */
    cwd?: string;
    /** Standard input */
    stdin?: 'pipe' | 'inherit' | 'null';
    /** Standard output */
    stdout?: 'pipe' | 'inherit' | 'null';
    /** Standard error */
    stderr?: 'pipe' | 'inherit' | 'null';
}

/**
 * Options for running a command to completion
 */
export interface RunOpts extends SpawnOpts {
    /** Timeout in milliseconds */
    timeout?: number;
    /** Maximum output buffer size in bytes */
    maxBuffer?: number;
}

/**
 * Handle to a running process
 */
export interface ProcessHandle {
    /** Process ID */
    pid: number;
    /** Process path/command */
    cmd: string;
    /** Send signal to process */
    kill(signal?: number): Promise<void>;
    /** Wait for process to exit */
    wait(): Promise<ProcessResult>;
    /** Write to stdin (if piped) */
    stdin?: WritableStream<Uint8Array>;
    /** Read from stdout (if piped) */
    stdout?: ReadableStream<Uint8Array>;
    /** Read from stderr (if piped) */
    stderr?: ReadableStream<Uint8Array>;
}

/**
 * Result of a completed process
 */
export interface ProcessResult {
    /** Exit code */
    exitCode: number;
    /** Signal that terminated the process, if any */
    signal?: string;
}

/**
 * Result of running a command to completion
 */
export interface RunResult extends ProcessResult {
    /** Buffered stdout */
    stdout: string;
    /** Buffered stderr */
    stderr: string;
}

// ============================================================================
// Service API Types
// ============================================================================

/**
 * Service status
 */
export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

/**
 * Service information returned by list/get operations
 */
export interface ServiceInfo {
    /** Service name (derived from handler path or explicit) */
    name: string;
    /** Handler path */
    handler: string;
    /** Current status */
    status: ServiceStatus;
    /** Process ID if running */
    pid?: number;
    /** Activation type */
    activationType: string;
    /** Error message if failed */
    error?: string;
    /** Start time (ms since epoch) */
    startedAt?: number;
}
