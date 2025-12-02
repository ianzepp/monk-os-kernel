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
 * operations via send(). The kernel dispatches based on handle type.
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
     * Send a message to the handle and receive streaming responses.
     *
     * @param msg - Message containing operation and data
     * @returns Async iterable of responses
     */
    send(msg: Message): AsyncIterable<Response>;

    /**
     * Close the handle and release resources.
     */
    close(): Promise<void>;
}
