/**
 * Message
 *
 * Universal message format for Monk OS.
 *
 * Philosophy: Everything is a message with an op and optional data.
 * Responses stream back as async iterables of messages.
 *
 * Used by:
 * - VFS Models: model.handle(ctx, id, msg) -> AsyncIterable<Response>
 * - Channels: channel.handle(msg) -> AsyncIterable<Response>
 * - Future: IPC, RPC, etc.
 */

import { EINVAL, EIO, fromCode } from '@src/hal/errors.js';

/**
 * Message sent to a handler.
 */
export interface Message {
    /** Operation to perform */
    op: string;
    /** Operation-specific data */
    data?: unknown;
}

/**
 * Response message from a handler.
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
 * Typed response definitions.
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
            /** Target location (URL, path, or protocol-specific address) */
            location: string;
            /** Whether this is permanent (cacheable) or temporary */
            permanent?: boolean;
            /** Optional reason/hint */
            reason?: string;
        };
    }
}

/**
 * Helper to create response messages.
 */
export const respond = {
    ok: (data?: unknown): Responses.Ok => ({ op: 'ok', data }),

    error: (code: string, message: string): Responses.Error => ({
        op: 'error',
        data: { code, message },
    }),

    item: (data: unknown): Responses.Item => ({ op: 'item', data }),

    data: (bytes: Uint8Array): Responses.Data => ({ op: 'data', bytes }),

    event: (type: string, data: Record<string, unknown> = {}): Responses.Event => ({
        op: 'event',
        data: { type, ...data },
    }),

    progress: (percent?: number, current?: number, total?: number): Responses.Progress => ({
        op: 'progress',
        data: { percent, current, total },
    }),

    done: (): Responses.Done => ({ op: 'done' }),

    redirect: (location: string, permanent = false, reason?: string): Responses.Redirect => ({
        op: 'redirect',
        data: { location, permanent, reason },
    }),
};

/**
 * Type guard for checking response op type.
 */
export function isResponseOp<T extends Response['op']>(
    response: Response,
    op: T
): response is Response & { op: T } {
    return response.op === op;
}

/**
 * Extract data from an 'ok' response, throw on 'error'.
 */
export function unwrapResponse<T = unknown>(response: Response): T {
    if (response.op === 'error') {
        const err = response.data as { code: string; message: string };
        throw fromCode(err.code, err.message);
    }
    if (response.op === 'ok') {
        return response.data as T;
    }
    throw new EINVAL(`Unexpected response op: ${response.op}`);
}

/**
 * Collect all 'item' responses from a stream into an array.
 */
export async function collectItems<T = unknown>(
    stream: AsyncIterable<Response>
): Promise<T[]> {
    const items: T[] = [];
    for await (const response of stream) {
        if (response.op === 'item') {
            items.push(response.data as T);
        } else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw fromCode(err.code, err.message);
        } else if (response.op === 'done') {
            break;
        }
    }
    return items;
}

/**
 * Unwrap a stream to a single value (first 'ok' response data).
 * Throws on 'error' response.
 */
export async function unwrapStream<T = unknown>(
    stream: AsyncIterable<Response>
): Promise<T> {
    for await (const response of stream) {
        if (response.op === 'ok') {
            return response.data as T;
        }
        if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw fromCode(err.code, err.message);
        }
    }
    throw new EIO('No ok response received');
}
