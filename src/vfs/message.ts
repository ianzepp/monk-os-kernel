/**
 * Message
 *
 * Universal message format for VFS operations.
 * Replaces method-based Model interface with message passing.
 *
 * Philosophy: Everything is a message with an op and optional data.
 * Responses stream back as async iterables of messages.
 */

import type { OpenFlags, OpenOptions } from '@src/vfs/handle.js';
import type { ModelStat } from '@src/vfs/model.js';

/**
 * Message sent to a Model.
 */
export interface Message {
    /** Operation to perform */
    op: string;
    /** Operation-specific data */
    data?: unknown;
}

/**
 * Response message from a Model.
 */
export interface Response {
    /** Response type */
    op: 'ok' | 'error' | 'item' | 'chunk' | 'event' | 'progress' | 'done';
    /** Response data */
    data?: unknown;
}

/**
 * Typed message definitions for standard operations.
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
    // Responses
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

/**
 * Helper to create response messages.
 */
export const respond = {
    ok: (data?: unknown): Messages.Ok => ({ op: 'ok', data }),

    error: (code: string, message: string): Messages.Error => ({
        op: 'error',
        data: { code, message },
    }),

    item: (data: unknown): Messages.Item => ({ op: 'item', data }),

    chunk: (data: Uint8Array): Messages.Chunk => ({ op: 'chunk', data }),

    event: (
        type: 'create' | 'update' | 'delete',
        entity: string,
        path: string,
        timestamp: number,
        fields?: string[]
    ): Messages.Event => ({
        op: 'event',
        data: { type, entity, path, timestamp, fields },
    }),

    progress: (percent?: number, current?: number, total?: number): Messages.Progress => ({
        op: 'progress',
        data: { percent, current, total },
    }),

    done: (): Messages.Done => ({ op: 'done' }),
};
