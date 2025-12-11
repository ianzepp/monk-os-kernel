/**
 * AI App Logging - Logging utilities for the AI process
 *
 * PURPOSE
 * =======
 * Provides structured logging for the AI process using the debug syscall
 * infrastructure. Messages go through debug:log for consistent output
 * with other OS components.
 *
 * DEBUG NAMESPACES
 * ================
 * - rom:ai        - Main AI process lifecycle
 * - rom:ai:task   - Task execution and agentic loop
 * - rom:ai:bang   - Bang command parsing and execution
 * - rom:ai:exec   - Shell command execution
 * - rom:ai:memory - Memory consolidation
 *
 * @module rom/app/ai/lib/logging
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    eprintln,
    debug as createDebugLogger,
    type DebugLogger,
} from '@rom/lib/process/index.js';

import { ID_CHARS, REQUEST_ID_LENGTH, SPAWN_ID_LENGTH } from './config.js';

// =============================================================================
// DEBUG LOGGERS
// =============================================================================

/**
 * Debug loggers for different namespaces.
 * Created lazily to avoid syscalls if not enabled.
 */
export const debugMain = createDebugLogger('rom:ai');
export const debugTask = createDebugLogger('rom:ai:task');
export const debugBang = createDebugLogger('rom:ai:bang');
export const debugExec = createDebugLogger('rom:ai:exec');
export const debugMemory = createDebugLogger('rom:ai:memory');

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
 * Log a message to stderr.
 *
 * This is the main log function for user-visible output.
 * For debug output, use the debug* loggers directly.
 *
 * @param message - The message to log
 * @param _requestId - Optional request ID (currently unused)
 */
export async function log(message: string, _requestId?: string): Promise<void> {
    await eprintln(message);
}
