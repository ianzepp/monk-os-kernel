/**
 * Gateway Debug Logging
 *
 * Simple debug output for gateway communications.
 * Enable with DEBUG=gateway or DEBUG=1 environment variable.
 *
 * @module gateway/debug
 */

const DEBUG_ENV = process.env.DEBUG ?? '';
const DEBUG = DEBUG_ENV === '1'
    || DEBUG_ENV === '*'
    || DEBUG_ENV.split(',').some(s => s.trim() === 'gateway');

/**
 * Log a debug message to stderr.
 */
export function debug(category: string, msg: string): void {
    if (DEBUG) {
        console.error(`[gateway:${category}] ${msg}`);
    }
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

/**
 * Log decoded message with type info for binary debugging.
 */
export function debugDecode(msg: { id?: string; call?: string; args?: unknown[] }): void {
    if (!DEBUG) {
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

    console.error(`[gateway:decode] ${out}`);
}
