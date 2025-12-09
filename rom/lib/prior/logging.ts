/**
 * Prior Logging - Logging utilities for the Prior AI process
 *
 * PURPOSE
 * =======
 * Provides structured logging for Prior with request ID correlation.
 * All log messages include the OS instance ID and optional request ID
 * for tracing across distributed systems.
 *
 * OUTPUT FORMAT
 * =============
 * [OSID] message
 * [OSID] [REQID] message
 *
 * Messages are written to both stderr and the UDP debug monitor.
 *
 * @module rom/lib/prior/logging
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    eprintln,
    debug,
    getenv,
} from '@rom/lib/process/index.js';

import { ID_CHARS, REQUEST_ID_LENGTH, SPAWN_ID_LENGTH } from './config.js';

// =============================================================================
// STATE
// =============================================================================

/**
 * Cached OS instance ID.
 * WHY: Avoid repeated getenv calls on every log.
 */
let osId: string | undefined;

// =============================================================================
// ID GENERATION
// =============================================================================

/**
 * Generate a random ID of the specified length.
 *
 * @param length - Number of characters
 * @returns Random alphanumeric string
 */
function generateId(length: number): string {
    let id = '';
    for (let i = 0; i < length; i++) {
        const index = Math.floor(Math.random() * ID_CHARS.length);
        const char = ID_CHARS[index];
        if (char !== undefined) {
            id += char;
        }
    }
    return id;
}

/**
 * Generate a 4-character request ID for correlation.
 *
 * @returns 4-char alphanumeric ID
 */
export function generateRequestId(): string {
    return generateId(REQUEST_ID_LENGTH);
}

/**
 * Generate an 8-character spawn ID with prefix.
 *
 * @returns ID in format "spawn:xxxxxxxx"
 */
export function generateSpawnId(): string {
    return `spawn:${generateId(SPAWN_ID_LENGTH)}`;
}

// =============================================================================
// LOGGING
// =============================================================================

/**
 * Log a message to both stderr and the UDP monitor.
 *
 * Format: [OSID] message  or  [OSID] [REQID] message
 *
 * @param message - The message to log
 * @param requestId - Optional request ID for correlation
 */
export async function log(message: string, requestId?: string): Promise<void> {
    if (osId === undefined) {
        osId = await getenv('MONK_OS') ?? '????';
    }
    const prefix = requestId ? `[${osId}] [${requestId}]` : `[${osId}]`;
    const formatted = `${prefix} ${message}`;
    await eprintln(formatted);
    await debug(formatted);
}
