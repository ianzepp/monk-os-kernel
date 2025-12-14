/**
 * Process Library Types
 *
 * Type definitions for userland process communication with the kernel.
 * These mirror kernel types but are self-contained for Worker isolation.
 *
 * @module rom/lib/process/types
 */

// =============================================================================
// RESPONSE PROTOCOL
// =============================================================================

/**
 * Response message from syscalls and message I/O.
 *
 * The Response protocol is how all data flows in Monk OS:
 * - Syscalls yield Response messages
 * - Pipes carry Response messages
 * - Files emit Response messages when read
 */
export interface Response {
    /** Response type */
    op: 'ok' | 'error' | 'item' | 'data' | 'event' | 'progress' | 'done' | 'redirect';
    /** Response data (for item, ok, error, event, progress, redirect) */
    data?: unknown;
    /** Binary bytes (for op: 'data' only) */
    bytes?: Uint8Array;
}

/**
 * Typed response definitions for type-safe handling.
 */
export namespace Responses {
    export interface Ok extends Response {
        op: 'ok';
        data?: unknown;
    }

    export interface Error extends Response {
        op: 'error';
        data: {
            code: string;
            message: string;
        };
    }

    export interface Item extends Response {
        op: 'item';
        data: unknown;
    }

    export interface Data extends Response {
        op: 'data';
        bytes: Uint8Array;
    }

    export interface Event extends Response {
        op: 'event';
        data: {
            type: string;
            [key: string]: unknown;
        };
    }

    export interface Progress extends Response {
        op: 'progress';
        data: {
            percent?: number;
            current?: number;
            total?: number;
        };
    }

    export interface Done extends Response {
        op: 'done';
    }

    export interface Redirect extends Response {
        op: 'redirect';
        data: {
            location: string;
            permanent?: boolean;
            reason?: string;
        };
    }
}

// =============================================================================
// WIRE FORMAT
// =============================================================================

/**
 * Syscall request from process to kernel.
 */
export interface SyscallRequest {
    type: 'syscall:request';
    /** Request correlation ID */
    id: string;
    /** Process ID making the syscall */
    pid: string;
    /** Syscall name (e.g., 'file:open', 'proc:spawn') */
    name: string;
    /** Syscall arguments */
    args: unknown[];
}

/**
 * Syscall response from kernel to process.
 */
export interface SyscallResponse {
    type: 'syscall:response';
    id: string;
    result?: Response;
}

/**
 * Signal message from kernel to process.
 */
export interface SignalMessage {
    type: 'signal';
    signal: number;
    payload?: unknown;
}

/**
 * Tick signal payload.
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
 * Stream ping message (progress report for backpressure).
 */
export interface StreamPingMessage {
    type: 'syscall:ping';
    id: string;
    processed: number;
}

/**
 * Stream cancel message (stop producing).
 */
export interface StreamCancelMessage {
    type: 'syscall:cancel';
    id: string;
}

/**
 * Port event message from kernel.
 */
export interface PortMessage {
    type: 'port';
    from: string;
    fd?: number;
    data?: Uint8Array;
    meta?: Record<string, unknown>;
}

/**
 * All message types from kernel.
 */
export type KernelMessage =
    | SyscallResponse
    | SignalMessage
    | PortMessage;

// =============================================================================
// DOMAIN TYPES
// =============================================================================

/**
 * File stat structure.
 *
 * Includes core VFS fields plus any model-specific or EMS fields
 * via the index signature.
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
    /** Modification time (ms since epoch) */
    mtime: number;
    /** Creation time (ms since epoch) */
    ctime: number;
    /** MIME type (optional) */
    mimetype?: string;
    /** Data blob UUID (for files) */
    data?: string;
    /** Symlink target (for links) */
    target?: string;
    /** Version tracking enabled */
    versioned?: boolean;
    /** Current version number */
    version?: number;
    /** Model-specific and EMS fields */
    [key: string]: unknown;
}

/**
 * ACL grant structure.
 */
export interface Grant {
    /** Grantee (user/group/public) */
    to: string;
    /** Operations allowed */
    ops: string[];
    /** Optional expiration timestamp */
    expires?: number;
}

/**
 * Open flags for file operations.
 */
export interface OpenFlags {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
}

/**
 * Spawn options for child processes.
 */
export interface SpawnOpts {
    /** Command-line arguments */
    args?: string[];
    /** Working directory */
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
 * Exit status from wait().
 */
export interface ExitStatus {
    /** Process ID that exited */
    pid: number;
    /** Exit code */
    code: number;
}

/**
 * Directory entry from readdir.
 */
export interface DirEntry {
    name: string;
    model: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Signal values */
export const SIGTERM = 15;
export const SIGTICK = 30;
export const SIGKILL = 9;

/** Stream backpressure thresholds (match kernel) */
export const STREAM_PING_INTERVAL = 100;

// =============================================================================
// ERROR CLASSES
// =============================================================================

/**
 * Base error class with code property.
 */
export class SyscallError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'SyscallError';
    }
}

/** No such process */
export class ESRCH extends SyscallError {
    constructor(message = 'No such process') {
        super('ESRCH', message);
        this.name = 'ESRCH';
    }
}

/** No such file or directory */
export class ENOENT extends SyscallError {
    constructor(message = 'No such file or directory') {
        super('ENOENT', message);
        this.name = 'ENOENT';
    }
}

/** Permission denied */
export class EACCES extends SyscallError {
    constructor(message = 'Permission denied') {
        super('EACCES', message);
        this.name = 'EACCES';
    }
}

/** Invalid argument */
export class EINVAL extends SyscallError {
    constructor(message = 'Invalid argument') {
        super('EINVAL', message);
        this.name = 'EINVAL';
    }
}

/** File exists */
export class EEXIST extends SyscallError {
    constructor(message = 'File exists') {
        super('EEXIST', message);
        this.name = 'EEXIST';
    }
}

/** Not a directory */
export class ENOTDIR extends SyscallError {
    constructor(message = 'Not a directory') {
        super('ENOTDIR', message);
        this.name = 'ENOTDIR';
    }
}

/** Is a directory */
export class EISDIR extends SyscallError {
    constructor(message = 'Is a directory') {
        super('EISDIR', message);
        this.name = 'EISDIR';
    }
}

/** Bad file descriptor */
export class EBADF extends SyscallError {
    constructor(message = 'Bad file descriptor') {
        super('EBADF', message);
        this.name = 'EBADF';
    }
}

/** I/O error */
export class EIO extends SyscallError {
    constructor(message = 'I/O error') {
        super('EIO', message);
        this.name = 'EIO';
    }
}

/** Function not implemented */
export class ENOSYS extends SyscallError {
    constructor(message = 'Function not implemented') {
        super('ENOSYS', message);
        this.name = 'ENOSYS';
    }
}

/**
 * Create error from code string.
 */
export function fromCode(code: string, message: string): SyscallError {
    switch (code) {
        case 'ESRCH': return new ESRCH(message);
        case 'ENOENT': return new ENOENT(message);
        case 'EACCES': return new EACCES(message);
        case 'EINVAL': return new EINVAL(message);
        case 'EEXIST': return new EEXIST(message);
        case 'ENOTDIR': return new ENOTDIR(message);
        case 'EISDIR': return new EISDIR(message);
        case 'EBADF': return new EBADF(message);
        case 'EIO': return new EIO(message);
        case 'ENOSYS': return new ENOSYS(message);
        default: return new SyscallError(code, message);
    }
}
