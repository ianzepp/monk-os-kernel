/**
 * VFS Message Types - Typed message definitions for VFS operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Monk OS uses a message-passing architecture for VFS operations. Instead of
 * direct method calls, operations are expressed as typed messages with responses.
 * This design enables:
 *
 * - Streaming: Large operations can yield multiple responses
 * - Async events: Watch operations emit events over time
 * - Serialization: Messages can be sent over IPC or network
 * - Replay: Message logs can be replayed for debugging/testing
 *
 * This module defines VFS-specific message types built on the core Message/Response
 * types from @src/message.js. It re-exports core types for backwards compatibility.
 *
 * MESSAGE FLOW
 * ============
 *
 *   Process ─────> VFS ─────> Model.handle() ─────> Storage
 *      │           │              │                    │
 *      │           │              │                    │
 *      │           │              ▼                    │
 *      │           │         yield Response ──────────>│
 *      │           │              │                    │
 *      │           ◄──────────────┘                    │
 *      │                                               │
 *      ◄───────────────────────────────────────────────┘
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every message has a unique 'id' for correlation
 * INV-2: Every response has 'ref' matching the request's 'id'
 * INV-3: Streaming operations end with 'done' response
 * INV-4: Error responses terminate the stream (no more responses after error)
 *
 * CONCURRENCY MODEL
 * =================
 * Messages are independent - multiple concurrent messages can be in flight.
 * Responses are correlated by 'id'/'ref' matching. The kernel ensures
 * ordering for responses to the same request.
 *
 * @module vfs/message
 */

import type { OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { ModelStat } from '@src/vfs/model.js';

// =============================================================================
// RE-EXPORTS FROM CORE MESSAGE MODULE
// =============================================================================

/**
 * Re-export core message types.
 *
 * WHY: Maintains backwards compatibility. Callers can import from
 * '@src/vfs/message.js' without knowing about the core module.
 */
export type { Message, Response, Responses } from '@src/message.js';
export { respond, isResponseOp, unwrapResponse, collectItems } from '@src/message.js';

// Import for local use in type definitions
import type { Message, Response } from '@src/message.js';

// =============================================================================
// VFS MESSAGE NAMESPACE
// =============================================================================

/**
 * Typed message definitions for VFS operations.
 *
 * Each message type extends the base Message interface with specific
 * 'op' value and 'data' structure.
 *
 * NAMING CONVENTION:
 * - Request messages: Named after operation (Open, Read, Write, etc.)
 * - Response messages: Named after response type (Ok, Error, Item, etc.)
 *
 * USAGE:
 * ```typescript
 * const msg: Messages.Open = {
 *     id: 'msg-1',
 *     op: 'open',
 *     path: '/foo/bar',
 *     data: { flags: { read: true } }
 * };
 * ```
 */
export namespace Messages {
    // =========================================================================
    // REQUEST MESSAGES
    // =========================================================================

    /**
     * Open file request.
     *
     * Opens a file for I/O operations. Returns handle ID on success.
     */
    export interface Open extends Message {
        op: 'open';
        data: {
            /** Open flags (read/write/create/etc.) */
            flags: OpenFlags;
            /** Additional open options */
            opts?: OpenOptions;
        };
    }

    /**
     * Read file request.
     *
     * Reads bytes from an open file handle. Returns Data response with bytes.
     */
    export interface Read extends Message {
        op: 'read';
        data?: {
            /** Maximum bytes to read */
            size?: number;
            /** Offset to read from (alternative to seek+read) */
            offset?: number;
        };
    }

    /**
     * Write file request.
     *
     * Writes bytes to an open file handle. Returns Ok on success.
     */
    export interface Write extends Message {
        op: 'write';
        /** Bytes to write */
        data: Uint8Array;
    }

    /**
     * Close handle request.
     *
     * Closes an open file handle. Flushes pending writes.
     */
    export interface Close extends Message {
        op: 'close';
    }

    /**
     * Stat request.
     *
     * Gets metadata for an entity. Returns ModelStat in Ok response.
     */
    export interface Stat extends Message {
        op: 'stat';
    }

    /**
     * Set stat request.
     *
     * Updates metadata fields on an entity.
     */
    export interface SetStat extends Message {
        op: 'setstat';
        /** Fields to update */
        data: Partial<ModelStat>;
    }

    /**
     * Create request.
     *
     * Creates a new entity. Returns created entity ID in Ok response.
     */
    export interface Create extends Message {
        op: 'create';
        data: {
            /** Name of new entity */
            name: string;
            /** Initial field values */
            fields?: Partial<ModelStat>;
        };
    }

    /**
     * Delete request.
     *
     * Removes an entity.
     */
    export interface Delete extends Message {
        op: 'delete';
    }

    /**
     * List request.
     *
     * Lists children of a directory. Returns Item responses followed by Done.
     */
    export interface List extends Message {
        op: 'list';
    }

    /**
     * Watch request.
     *
     * Watches for changes. Returns Event responses as changes occur.
     * Does not automatically end - continues until handle is closed.
     */
    export interface Watch extends Message {
        op: 'watch';
        data?: {
            /** Glob pattern to filter events */
            pattern?: string;
        };
    }

    // =========================================================================
    // RESPONSE MESSAGES (VFS-specific typed versions)
    // =========================================================================

    /**
     * Success response.
     *
     * Indicates operation completed successfully.
     * May contain result data depending on operation.
     */
    export interface Ok extends Response {
        op: 'ok';
        /** Operation-specific result data */
        data?: unknown;
    }

    /**
     * Error response.
     *
     * Indicates operation failed. Terminates the response stream.
     */
    export interface Error extends Response {
        op: 'error';
        data: {
            /** Error code (e.g., 'ENOENT', 'EACCES') */
            code: string;
            /** Human-readable error message */
            message: string;
        };
    }

    /**
     * Item response.
     *
     * Emitted by list operations for each item. Followed by Done.
     */
    export interface Item extends Response {
        op: 'item';
        /** Item data (typically ModelStat) */
        data: unknown;
    }

    /**
     * Data response.
     *
     * Returns binary data from read operations.
     */
    export interface Data extends Response {
        op: 'data';
        /** Binary content */
        bytes: Uint8Array;
    }

    /**
     * Event response.
     *
     * Emitted by watch operations when changes occur.
     */
    export interface Event extends Response {
        op: 'event';
        data: {
            /** Type of change */
            type: 'create' | 'update' | 'delete';
            /** Entity UUID that changed */
            entity: string;
            /** Path of entity */
            path: string;
            /** Fields that changed (for update events) */
            fields?: string[];
            /** Timestamp of change */
            timestamp: number;
        };
    }

    /**
     * Progress response.
     *
     * Emitted during long-running operations to indicate progress.
     */
    export interface Progress extends Response {
        op: 'progress';
        data: {
            /** Percentage complete (0-100) */
            percent?: number;
            /** Current item number */
            current?: number;
            /** Total items */
            total?: number;
        };
    }

    /**
     * Done response.
     *
     * Indicates a streaming operation has completed.
     * Emitted after all Item/Event/Data responses.
     */
    export interface Done extends Response {
        op: 'done';
    }
}
