/**
 * Response Helpers
 *
 * Factory functions for creating Response messages.
 *
 * @module rom/lib/process/respond
 */

import type { Responses } from './types.js';

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
