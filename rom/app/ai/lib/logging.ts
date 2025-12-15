/**
 * AI App Logging - Logging utilities for the AI process
 *
 * PURPOSE
 * =======
 * Provides structured logging for the AI process using the standard
 * kernel debug infrastructure. Output follows the standard format:
 *
 *   HH:mm:ss.SSS [ai] message
 *
 * Debug output is controlled by the DEBUG environment variable.
 * Set DEBUG=ai or DEBUG=ai:* to enable AI logging.
 *
 * @module rom/app/ai/lib/logging
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { debug as createDebug, debugInit } from '@rom/lib/process/debug.js';

import { ID_CHARS, REQUEST_ID_LENGTH, SPAWN_ID_LENGTH } from './config.js';

// =============================================================================
// DEBUG LOGGER
// =============================================================================

/**
 * Debug logger for the AI process.
 * Uses 'ai' namespace for standard debug output.
 */
export const log = createDebug('ai');

/**
 * Initialize debug logging.
 * Must be called once at process startup before using log().
 */
export { debugInit };

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

