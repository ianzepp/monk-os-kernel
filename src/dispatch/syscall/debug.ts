/**
 * Debug Syscalls - Runtime debug logging control
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Debug syscalls allow processes to interact with the debug logging system.
 * They provide runtime inspection of debug state and the ability to log
 * messages through the standard debug infrastructure.
 *
 * SYSCALLS
 * ========
 * - debug:enabled - Check if a namespace is enabled for debug output
 * - debug:log - Log a message to a namespace (if enabled)
 * - debug:patterns - List all enabled debug patterns
 *
 * DESIGN NOTES
 * ============
 * These syscalls are stateless - they query/use the debug module's state
 * which is configured at process startup via DEBUG environment variable.
 * There's no runtime modification of debug patterns (by design - patterns
 * are set once at module load time).
 *
 * @module syscall/debug
 */

import type { Process, Response } from '../types.js';
import { respond } from '../types.js';
import { debug, debugPatterns } from '@src/debug.js';

// =============================================================================
// DEBUG:ENABLED
// =============================================================================

/**
 * Check if a debug namespace is enabled.
 *
 * @param proc - Calling process
 * @param namespace - Namespace to check (e.g., 'hal:init', 'ems:*')
 * @yields Response with boolean enabled status
 *
 * @example
 * // Syscall: debug:enabled 'hal:init'
 * // Returns: { op: 'ok', data: true }
 */
export async function* debugIsEnabled(
    proc: Process,
    namespace: unknown,
): AsyncGenerator<Response> {
    if (typeof namespace !== 'string') {
        yield respond.error('EINVAL', 'namespace must be a string');

        return;
    }

    const logger = debug(namespace);

    yield respond.ok(logger.enabled);
}

// =============================================================================
// DEBUG:LOG
// =============================================================================

/**
 * Log a debug message to a namespace.
 *
 * Only logs if the namespace is enabled. This allows processes to emit
 * debug output that integrates with the standard DEBUG= logging.
 *
 * @param proc - Calling process
 * @param namespace - Debug namespace (e.g., 'myapp:init')
 * @param message - Message to log (supports printf-style %s, %d, etc.)
 * @param args - Optional format arguments
 * @yields Response with ok (logged) or ok with false (namespace not enabled)
 *
 * @example
 * // Syscall: debug:log 'myapp:init' 'Starting service: %s' 'httpd'
 * // Output: 12:34:56.789 [myapp:init] Starting service: httpd
 */
export async function* debugLog(
    proc: Process,
    namespace: unknown,
    message: unknown,
    ...args: unknown[]
): AsyncGenerator<Response> {
    if (typeof namespace !== 'string') {
        yield respond.error('EINVAL', 'namespace must be a string');

        return;
    }

    if (typeof message !== 'string') {
        yield respond.error('EINVAL', 'message must be a string');

        return;
    }

    const logger = debug(namespace);

    if (logger.enabled) {
        logger(message, ...args);
        yield respond.ok(true);
    }
    else {
        yield respond.ok(false);
    }
}

// =============================================================================
// DEBUG:PATTERNS
// =============================================================================

/**
 * List all enabled debug patterns.
 *
 * Returns the patterns configured via the DEBUG environment variable.
 * Useful for diagnostics and understanding what debug output is active.
 *
 * @param proc - Calling process
 * @yields Response with array of enabled patterns
 *
 * @example
 * // Syscall: debug:patterns
 * // Returns: { op: 'ok', data: ['hal:*', 'ems:init'] }
 */
export async function* debugListPatterns(
    proc: Process,
): AsyncGenerator<Response> {
    yield respond.ok(debugPatterns());
}
