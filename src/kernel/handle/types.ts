/**
 * Handle Types
 *
 * Shared types and interfaces for the unified handle architecture.
 */

import type { Message, Response } from '@src/message.js';

/**
 * Handle type discriminator
 */
export type HandleType = 'file' | 'socket' | 'pipe' | 'port' | 'channel' | 'process-io';

/**
 * Unified handle interface.
 *
 * All I/O primitives implement this interface, providing message-based
 * operations via exec(). The kernel dispatches based on handle type.
 */
export interface Handle {
    /** Unique handle identifier */
    readonly id: string;

    /** Handle type for dispatch */
    readonly type: HandleType;

    /** Human-readable description (path, address, protocol) */
    readonly description: string;

    /** Whether the handle is closed */
    readonly closed: boolean;

    /**
     * Execute a message/command on the handle and receive streaming responses.
     *
     * Named exec() to avoid collision with msg.op = 'send'.
     *
     * @param msg - Message containing operation and data
     * @returns Async iterable of responses
     */
    exec(msg: Message): AsyncIterable<Response>;

    /**
     * Close the handle and release resources.
     */
    close(): Promise<void>;
}
