/**
 * Gateway Debug Logging
 *
 * Simple debug output for gateway communications.
 * Enable with DEBUG=gateway:* environment variable.
 *
 * @module gateway/debug
 */

import { debug as createDebugger } from '@src/debug.js';

// Create loggers for different gateway categories
const loggers = new Map<string, ReturnType<typeof createDebugger>>();

function getLogger(category: string): ReturnType<typeof createDebugger> {
    let logger = loggers.get(category);

    if (!logger) {
        logger = createDebugger(`gateway:${category}`);
        loggers.set(category, logger);
    }

    return logger;
}

/**
 * Log a debug message to stderr.
 */
export function debug(category: string, msg: string): void {
    getLogger(category)(msg);
}

/**
 * Describe a value's type for debugging.
 */
function describeType(value: unknown): string {
    if (value === null) {
        return 'null';
    }

    if (value === undefined) {
        return 'undefined';
    }

    if (typeof value !== 'object') {
        return typeof value;
    }

    if (value instanceof Uint8Array) {
        return `Uint8Array(${value.length})`;
    }

    if (Array.isArray(value)) {
        return `Array(${value.length})`;
    }

    return value.constructor?.name ?? 'Object';
}

// Decode logger for binary debugging
const decodeLog = createDebugger('gateway:decode');

/**
 * Log decoded message with type info for binary debugging.
 */
export function debugDecode(msg: { id?: string; call?: string; args?: unknown[] }): void {
    if (!decodeLog.enabled) {
        return;
    }

    let out = `id=${msg.id} call=${msg.call}`;

    if (msg.args?.length) {
        const argTypes = msg.args.map((a, i) => `[${i}]${describeType(a)}`).join(' ');

        out += ` args: ${argTypes}`;

        // Check for binary data issues
        for (const arg of msg.args) {
            if (arg && typeof arg === 'object' && 'data' in arg) {
                const data = (arg as { data: unknown }).data;
                const ok = data instanceof Uint8Array;

                out += ` | .data=${describeType(data)}${ok ? '' : ' WARNING'}`;
            }
        }
    }

    decodeLog(out);
}
