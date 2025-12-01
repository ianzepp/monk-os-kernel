/**
 * VFS Message Types
 *
 * VFS-specific message definitions built on the core Message/Response types.
 * Re-exports core types for backwards compatibility.
 */

import type { OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { ModelStat } from '@src/vfs/model.js';

// Re-export core message types
export type { Message, Response, Responses } from '@src/message.js';
export { respond, isResponseOp, unwrapResponse, collectItems } from '@src/message.js';

// Import for local use
import type { Message, Response } from '@src/message.js';

/**
 * Typed message definitions for VFS operations.
 */
export namespace Messages {
    // ========================================================================
    // Requests
    // ========================================================================

    export interface Open extends Message {
        op: 'open';
        data: {
            flags: OpenFlags;
            opts?: OpenOptions;
        };
    }

    export interface Read extends Message {
        op: 'read';
        data?: {
            size?: number;
            offset?: number;
        };
    }

    export interface Write extends Message {
        op: 'write';
        data: Uint8Array;
    }

    export interface Close extends Message {
        op: 'close';
    }

    export interface Stat extends Message {
        op: 'stat';
    }

    export interface SetStat extends Message {
        op: 'setstat';
        data: Partial<ModelStat>;
    }

    export interface Create extends Message {
        op: 'create';
        data: {
            name: string;
            fields?: Partial<ModelStat>;
        };
    }

    export interface Delete extends Message {
        op: 'delete';
    }

    export interface List extends Message {
        op: 'list';
    }

    export interface Watch extends Message {
        op: 'watch';
        data?: {
            pattern?: string;
        };
    }

    // ========================================================================
    // Responses (VFS-specific typed versions)
    // ========================================================================

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

    export interface Chunk extends Response {
        op: 'chunk';
        data: Uint8Array;
    }

    export interface Event extends Response {
        op: 'event';
        data: {
            type: 'create' | 'update' | 'delete';
            entity: string;
            path: string;
            fields?: string[];
            timestamp: number;
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
}
