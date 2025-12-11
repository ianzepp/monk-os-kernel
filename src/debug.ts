/**
 * Debug Logging
 *
 * Traditional DEBUG environment variable pattern for selective logging.
 * Supports namespace patterns like DEBUG=hal:*,ems:init,kernel:spawn
 *
 * USAGE:
 *   import { debug } from '@src/debug.js';
 *   const log = debug('hal:init');
 *   log('Starting HAL initialization');
 *   log('Storage type: %s', storageType);
 *
 * ENVIRONMENT:
 *   DEBUG=*              # All namespaces
 *   DEBUG=hal:*          # All hal namespaces
 *   DEBUG=hal:init       # Specific namespace
 *   DEBUG=hal:*,ems:*    # Multiple patterns
 *   DEBUG=*,-hal:storage # All except hal:storage
 *
 * OUTPUT FORMAT:
 *   [hal:init] Starting HAL initialization
 *   [hal:init] Storage type: sqlite
 *
 * @module debug
 */

// WHY: Parse DEBUG env once at module load, not on every log call.
// Patterns are cached as RegExp for fast matching.
const DEBUG_ENV = process.env.DEBUG ?? '';

interface ParsedPatterns {
    include: RegExp[];
    exclude: RegExp[];
}

/**
 * Parse DEBUG environment variable into include/exclude patterns.
 *
 * WHY: Supports traditional debug patterns:
 * - Exact match: "hal:init"
 * - Wildcard suffix: "hal:*"
 * - Global wildcard: "*"
 * - Exclusion prefix: "-hal:storage"
 */
function parsePatterns(env: string): ParsedPatterns {
    const include: RegExp[] = [];
    const exclude: RegExp[] = [];

    if (!env) {
        return { include, exclude };
    }

    const parts = env.split(',').map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
        const isExclude = part.startsWith('-');
        const pattern = isExclude ? part.slice(1) : part;

        // Convert glob pattern to regex
        // WHY: Simple conversion - only support * at end (hal:* -> hal:.*)
        const regexStr = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars
            .replace(/\*/g, '.*');                   // Convert * to .*

        const regex = new RegExp(`^${regexStr}$`);

        if (isExclude) {
            exclude.push(regex);
        }
        else {
            include.push(regex);
        }
    }

    return { include, exclude };
}

const patterns = parsePatterns(DEBUG_ENV);

/**
 * Check if a namespace is enabled for debug output.
 *
 * WHY: Cached check - patterns parsed once, matching is fast.
 * Exclusions take precedence over inclusions.
 */
function isEnabled(namespace: string): boolean {
    // No patterns means no debug output
    if (patterns.include.length === 0) {
        return false;
    }

    // Check exclusions first (they take precedence)
    for (const regex of patterns.exclude) {
        if (regex.test(namespace)) {
            return false;
        }
    }

    // Check inclusions
    for (const regex of patterns.include) {
        if (regex.test(namespace)) {
            return true;
        }
    }

    return false;
}

/**
 * Format a log message with printf-style substitution.
 *
 * WHY: Supports common patterns like log('value: %s', value)
 * without requiring template literals everywhere.
 *
 * Supported specifiers:
 * - %s: String
 * - %d, %i: Integer
 * - %f: Float
 * - %o, %O: Object (JSON)
 * - %j: JSON (compact)
 * - %%: Literal %
 */
function format(msg: string, args: unknown[]): string {
    if (args.length === 0) {
        return msg;
    }

    let argIndex = 0;

    return msg.replace(/%([sdifojO%])/g, (match, specifier) => {
        if (specifier === '%') {
            return '%';
        }

        if (argIndex >= args.length) {
            return match;
        }

        const arg = args[argIndex++];

        switch (specifier) {
            case 's':
                return String(arg);
            case 'd':
            case 'i':
                return String(Math.floor(Number(arg)));
            case 'f':
                return String(Number(arg));
            case 'o':
            case 'O':
            case 'j':
                try {
                    return JSON.stringify(arg);
                }
                catch {
                    return '[circular]';
                }
            default:
                return match;
        }
    });
}

/**
 * Debug logger function type.
 */
export interface DebugLogger {
    (msg: string, ...args: unknown[]): void;
    enabled: boolean;
    namespace: string;
}

/**
 * Create a debug logger for a namespace.
 *
 * WHY: Returns a function that only logs if the namespace is enabled.
 * The enabled check happens once at creation time, making logging
 * calls essentially free when disabled.
 *
 * @param namespace - Namespace like 'hal:init' or 'ems:observer'
 * @returns Debug logger function
 *
 * @example
 * const log = debug('hal:init');
 * log('Starting initialization');
 * log('Config: %o', config);
 */
export function debug(namespace: string): DebugLogger {
    const enabled = isEnabled(namespace);

    const logger = ((msg: string, ...args: unknown[]) => {
        if (!enabled) {
            return;
        }

        const formatted = format(msg, args);
        const timestamp = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS

        console.error(`${timestamp} [${namespace}] ${formatted}`);
    }) as DebugLogger;

    logger.enabled = enabled;
    logger.namespace = namespace;

    return logger;
}

/**
 * Check if any debug logging is enabled.
 *
 * WHY: Allows skipping expensive debug-only computations.
 *
 * @example
 * if (debugEnabled()) {
 *     const expensiveData = computeDebugInfo();
 *     log('Debug info: %o', expensiveData);
 * }
 */
export function debugEnabled(): boolean {
    return patterns.include.length > 0;
}

/**
 * List all enabled debug patterns (for diagnostics).
 */
export function debugPatterns(): string[] {
    return patterns.include.map(r => r.source.replace(/\.\*/g, '*').replace(/\^|\$/g, ''));
}
