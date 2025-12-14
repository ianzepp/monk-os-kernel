/**
 * Debug Logging for Userland Processes
 *
 * Provides a debug() function similar to the kernel's debug module.
 * Pattern matching is done locally after fetching patterns once at init.
 * Actual log output goes through debug:log syscall.
 *
 * USAGE:
 * ```typescript
 * import { debug, debugInit } from 'rom/lib/process';
 *
 * // Call once at process startup
 * await debugInit();
 *
 * // Create loggers (synchronous, no syscalls)
 * const log = debug('myapp:init');
 * log('starting up');
 * log('loaded %d items', items.length);
 *
 * if (log.enabled) {
 *     // expensive debug-only work
 * }
 * ```
 *
 * @module rom/lib/process/debug
 */

import { call } from './syscall.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Debug logger function with metadata.
 */
export interface DebugLogger {
    (message: string, ...args: unknown[]): void;
    /** Whether this namespace is enabled */
    enabled: boolean;
    /** The namespace string */
    namespace: string;
}

// =============================================================================
// PATTERN STATE
// =============================================================================

/**
 * Parsed patterns from DEBUG= environment variable.
 * Populated by debugInit().
 */
const patterns: {
    include: RegExp[];
    exclude: RegExp[];
} = {
    include: [],
    exclude: [],
};

/**
 * Whether debugInit() has been called.
 */
let initialized = false;

/**
 * Cache of created loggers by namespace.
 */
const loggerCache = new Map<string, DebugLogger>();

// =============================================================================
// PATTERN MATCHING
// =============================================================================

/**
 * Convert a debug pattern to a regex.
 * Supports wildcards: 'hal:*' matches 'hal:init', 'hal:storage', etc.
 */
function patternToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    return new RegExp(`^${escaped}$`);
}

/**
 * Check if a namespace matches the configured patterns.
 */
function isEnabled(namespace: string): boolean {
    // Check exclusions first
    for (const re of patterns.exclude) {
        if (re.test(namespace)) {
            return false;
        }
    }

    // Check inclusions
    for (const re of patterns.include) {
        if (re.test(namespace)) {
            return true;
        }
    }

    return false;
}

// =============================================================================
// PRINTF-STYLE FORMATTING
// =============================================================================

/**
 * Format a message with printf-style placeholders.
 */
function format(msg: string, args: unknown[]): string {
    let i = 0;

    return msg.replace(/%([sdoOjf%])/g, (match, specifier) => {
        if (specifier === '%') {
            return '%';
        }

        if (i >= args.length) {
            return match;
        }

        const arg = args[i++];

        switch (specifier) {
            case 's': return String(arg);
            case 'd': return Number(arg).toString();
            case 'f': return Number(arg).toString();
            case 'o':
            case 'O':
            case 'j':
                try {
                    return JSON.stringify(arg);
                }
                catch {
                    return '[Circular]';
                }

            default: return match;
        }
    });
}

// =============================================================================
// DEBUG FUNCTION
// =============================================================================

/**
 * Create a debug logger for a namespace.
 *
 * Pattern matching is done locally (no syscall). Log output goes
 * through debug:log syscall only if enabled.
 *
 * NOTE: Call debugInit() once at process startup before using debug().
 * If debugInit() hasn't been called, all loggers are disabled.
 *
 * @param namespace - Debug namespace (e.g., 'myapp:init', 'httpd:request')
 * @returns Logger function with enabled property
 */
export function debug(namespace: string): DebugLogger {
    // Return cached logger if exists
    const cached = loggerCache.get(namespace);

    if (cached) {
        return cached;
    }

    // Check if enabled (local pattern matching, no syscall)
    const enabled = initialized && isEnabled(namespace);

    const logger = ((message: string, ...args: unknown[]) => {
        if (!logger.enabled) {
            return;
        }

        // Format locally, send via syscall
        const formatted = format(message, args);

        // Fire and forget - use debug:log syscall
        call('debug:log', namespace, formatted).catch(() => {
            // Ignore errors - debug logging should never break the app
        });
    }) as DebugLogger;

    logger.enabled = enabled;
    logger.namespace = namespace;

    loggerCache.set(namespace, logger);

    return logger;
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize debug logging by fetching patterns from kernel.
 *
 * Call this once at process startup. After init, debug() calls
 * are synchronous (pattern matching is local).
 *
 * @returns List of enabled patterns
 */
export async function debugInit(): Promise<string[]> {
    if (initialized) {
        return patterns.include.map(r => r.source);
    }

    try {
        const rawPatterns = await call<string[]>('debug:patterns');

        for (const pattern of rawPatterns) {
            if (pattern.startsWith('-')) {
                patterns.exclude.push(patternToRegex(pattern.slice(1)));
            }
            else {
                patterns.include.push(patternToRegex(pattern));
            }
        }

        initialized = true;

        // Update any loggers that were created before init
        for (const [namespace, logger] of loggerCache) {
            logger.enabled = isEnabled(namespace);
        }

        return rawPatterns;
    }
    catch {
        initialized = true;

        return [];
    }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if debug logging is enabled globally.
 */
export function debugEnabled(): boolean {
    return patterns.include.length > 0;
}

/**
 * Get the list of enabled debug patterns.
 */
export function debugPatterns(): string[] {
    return patterns.include.map(r =>
        r.source.replace(/\^|\$/g, '').replace(/\.\*/g, '*'),
    );
}
