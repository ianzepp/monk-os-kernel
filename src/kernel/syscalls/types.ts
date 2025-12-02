/**
 * Syscall Types
 *
 * Shared types and interfaces for syscall implementations.
 */

import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';

/**
 * Syscall handler function type
 *
 * All handlers are async generators yielding Response objects.
 * Single-value handlers yield respond.ok(value).
 * Collection handlers yield respond.item(x) per item, then respond.done().
 */
export type SyscallHandler = (
    proc: Process,
    ...args: unknown[]
) => AsyncIterable<Response>;

/**
 * Syscall registry
 */
export interface SyscallRegistry {
    [name: string]: SyscallHandler;
}

/**
 * Port message returned to process.
 *
 * For tcp:listen: fd is the accepted connection
 * For udp/pubsub/watch: data is the payload
 */
export interface ProcessPortMessage {
    /** Source identifier */
    from: string;

    /** File descriptor for accepted connections (tcp:listen) */
    fd?: number;

    /** Payload data (udp, pubsub, watch) */
    data?: Uint8Array;

    /** Optional metadata */
    meta?: Record<string, unknown>;
}
