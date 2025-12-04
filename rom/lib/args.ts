/**
 * Argument Parsing Library - Command-line argument parser for Monk OS utilities
 *
 * PURPOSE
 * =======
 * This library provides type-safe, POSIX/GNU-compatible command-line argument
 * parsing for Monk OS userspace commands. It handles both short flags (-l, -la),
 * long flags (--long, --long=value), combined flags, and positional arguments
 * following standard Unix conventions.
 *
 * The parser is designed to be pure and stateless - no I/O, no side effects, just
 * argument transformation. This makes it easy to test and compose into larger
 * command implementations.
 *
 * API DESIGN
 * ==========
 * The main export is parseArgs(), which takes an argument array and a specification
 * object describing expected flags. It returns a structured result with flags,
 * positional arguments, unknown flags, and errors.
 *
 * The API is declarative: you describe what arguments you expect, and the parser
 * handles all the GNU conventions (combined short flags, --flag=value syntax,
 * -- to end flag parsing, etc.).
 *
 * Helper functions like parseDuration() provide common parsing patterns for
 * specific value types.
 *
 * ERROR HANDLING
 * ==============
 * This library never throws exceptions or calls exit(). All errors are collected
 * in the returned ParsedArgs.errors array. This allows commands to decide how to
 * handle errors (print to stderr, show help, exit with specific codes).
 *
 * Unknown flags are similarly collected in ParsedArgs.unknown, allowing flexible
 * error reporting or flag forwarding to subcommands.
 *
 * USAGE EXAMPLES
 * ==============
 * ```typescript
 * // Example 1: Basic flag parsing
 * const result = parseArgs(['-la', 'file.txt'], {
 *     l: { short: 'l', desc: 'Long format' },
 *     a: { short: 'a', desc: 'Show all' },
 * });
 * // result.flags = { l: true, a: true }
 * // result.positional = ['file.txt']
 *
 * // Example 2: Flags with values
 * const result = parseArgs(['--count=10', '-n', '5', 'input.txt'], {
 *     count: { long: 'count', value: true, default: '1' },
 *     n: { short: 'n', value: true, required: true },
 * });
 * // result.flags = { count: '10', n: '5' }
 * // result.positional = ['input.txt']
 *
 * // Example 3: Duration parsing
 * const ms = parseDuration('5s');  // 5000
 * const ms = parseDuration('500ms'); // 500
 * const ms = parseDuration('1m');  // 60000
 * ```
 *
 * @module rom/lib/args
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Argument specification for parseArgs().
 *
 * Describes a single command-line flag or option, including its short form
 * (e.g., -l), long form (e.g., --long), whether it takes a value, and
 * validation/default behavior.
 */
export interface ArgSpec {
    /** Short flag (single character, e.g., 'l' for -l) */
    short?: string;

    /** Long flag (multi-character, e.g., 'long' for --long) */
    long?: string;

    /** Flag takes a value (e.g., -n 10 or --count=10) */
    value?: boolean;

    /** Value is required (error if flag present without value) */
    required?: boolean;

    /** Default value if flag not provided */
    default?: string | boolean;

    /** Description for help text generation */
    desc?: string;
}

/**
 * Result from parseArgs().
 *
 * Contains all parsed flags, positional arguments, unknown flags encountered,
 * and any parsing errors. Errors and unknown flags are collected rather than
 * thrown, allowing the caller to decide how to handle them.
 */
export interface ParsedArgs {
    /** Flag values (boolean for flags, string for value flags) */
    flags: Record<string, string | boolean>;

    /** Positional arguments (non-flag tokens) */
    positional: string[];

    /** Unknown flags encountered during parsing */
    unknown: string[];

    /** Parse errors (e.g., missing required values) */
    errors: string[];
}

// =============================================================================
// MAIN FUNCTIONS
// =============================================================================

/**
 * Parse command-line arguments according to GNU/POSIX conventions.
 *
 * CONVENTIONS:
 * - Short flags: -l, -a, -n
 * - Combined short flags: -la equals -l -a
 * - Short flags with values: -n10 or -n 10
 * - Long flags: --long, --verbose
 * - Long flags with values: --count=10 or --count 10
 * - "--" ends flag parsing (remaining args are positional)
 * - "-" is treated as positional (stdin by convention)
 * - Unknown flags are collected, not errors
 *
 * @param args - Raw argument array (typically from process.argv.slice(2))
 * @param specs - Argument specifications keyed by flag name
 * @returns Parsed arguments with flags, positional args, errors, and unknown flags
 *
 * @example
 * // Parse ls-style flags
 * const result = parseArgs(['-la', '-n', '10', 'file.txt'], {
 *     l: { short: 'l', desc: 'Long format' },
 *     a: { short: 'a', desc: 'Show all' },
 *     n: { short: 'n', value: true, desc: 'Line count' },
 * });
 * // result.flags = { l: true, a: true, n: '10' }
 * // result.positional = ['file.txt']
 *
 * @example
 * // Handle unknown flags
 * const result = parseArgs(['--unknown', 'file.txt'], {});
 * // result.unknown = ['--unknown']
 * // result.positional = ['file.txt']
 */
export function parseArgs(
    args: string[],
    specs: Record<string, ArgSpec> = {}
): ParsedArgs {
    const result: ParsedArgs = {
        flags: {},
        positional: [],
        unknown: [],
        errors: [],
    };

    // -------------------------------------------------------------------------
    // Build Lookup Maps
    // -------------------------------------------------------------------------
    // Create maps for fast flag lookups: short flag -> spec key, long flag -> spec key
    const shortMap = new Map<string, string>();
    const longMap = new Map<string, string>();

    for (const [key, spec] of Object.entries(specs)) {
        if (spec.short !== undefined) {
            shortMap.set(spec.short, key);
        }
        if (spec.long !== undefined) {
            longMap.set(spec.long, key);
        }
        // Apply default values
        if (spec.default !== undefined) {
            result.flags[key] = spec.default;
        }
    }

    // -------------------------------------------------------------------------
    // Parse Arguments
    // -------------------------------------------------------------------------
    let i = 0;
    let positionalOnly = false;

    while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
            // SAFETY: With noUncheckedIndexedAccess, args[i] might be undefined
            // This should never happen since we check i < args.length, but TypeScript
            // doesn't know that.
            break;
        }

        // GNU: "--" ends option parsing, everything after is positional
        if (arg === '--') {
            positionalOnly = true;
            i++;
            continue;
        }

        // POSIX: "-" is treated as positional (conventionally means stdin)
        // Non-flags are always positional
        if (positionalOnly || !arg.startsWith('-') || arg === '-') {
            result.positional.push(arg);
            i++;
            continue;
        }

        // =====================================================================
        // Long Flags: --flag or --flag=value
        // =====================================================================
        if (arg.startsWith('--')) {
            const eqIndex = arg.indexOf('=');
            let flagName: string;
            let flagValue: string | undefined;

            if (eqIndex !== -1) {
                // --flag=value syntax
                flagName = arg.slice(2, eqIndex);
                flagValue = arg.slice(eqIndex + 1);
            } else {
                // --flag syntax
                flagName = arg.slice(2);
            }

            const specKey = longMap.get(flagName);
            if (specKey === undefined) {
                // Unknown flag - collect but don't error
                result.unknown.push(arg);
                i++;
                continue;
            }

            const spec = specs[specKey];
            if (spec === undefined) {
                // SAFETY: This should never happen since we got specKey from the map
                i++;
                continue;
            }

            if (spec.value === true) {
                // Flag expects a value
                if (flagValue !== undefined) {
                    // Value from --flag=value
                    result.flags[specKey] = flagValue;
                } else {
                    // Value from next arg: --flag value
                    const nextArg = args[i + 1];
                    if (nextArg !== undefined && !nextArg.startsWith('-')) {
                        result.flags[specKey] = nextArg;
                        i++;
                    } else if (spec.required === true) {
                        result.errors.push(`--${flagName} requires a value`);
                    } else {
                        // Optional value not provided, treat as boolean
                        result.flags[specKey] = true;
                    }
                }
            } else {
                // Boolean flag
                result.flags[specKey] = true;
            }
            i++;
            continue;
        }

        // =====================================================================
        // Short Flags: -l, -la, -n10, -n 10
        // =====================================================================
        const shortFlags = arg.slice(1);
        let j = 0;

        while (j < shortFlags.length) {
            const char = shortFlags[j];
            if (char === undefined) {
                // SAFETY: Handle undefined from noUncheckedIndexedAccess
                break;
            }

            const specKey = shortMap.get(char);
            if (specKey === undefined) {
                // Unknown short flag
                result.unknown.push(`-${char}`);
                j++;
                continue;
            }

            const spec = specs[specKey];
            if (spec === undefined) {
                // SAFETY: This should never happen
                j++;
                continue;
            }

            if (spec.value === true) {
                // Flag expects a value
                // Rest of this arg is the value (-n10), or next arg is the value (-n 10)
                const rest = shortFlags.slice(j + 1);
                if (rest.length > 0) {
                    // -n10 style
                    result.flags[specKey] = rest;
                    break; // Consumed rest of this arg
                } else {
                    // -n 10 style
                    const nextArg = args[i + 1];
                    if (nextArg !== undefined && !nextArg.startsWith('-')) {
                        result.flags[specKey] = nextArg;
                        i++;
                    } else if (spec.required === true) {
                        result.errors.push(`-${char} requires a value`);
                    } else {
                        // Optional value not provided
                        result.flags[specKey] = true;
                    }
                }
                j++;
            } else {
                // Boolean flag
                result.flags[specKey] = true;
                j++;
            }
        }
        i++;
    }

    return result;
}

/**
 * Parse duration string into milliseconds.
 *
 * Supports common duration formats: bare numbers (treated as seconds),
 * milliseconds (ms), seconds (s), minutes (m), and hours (h).
 *
 * @param str - Duration string to parse
 * @returns Duration in milliseconds, or null if format is invalid
 *
 * @example
 * parseDuration('5')     // 5000 (bare number = seconds)
 * parseDuration('5s')    // 5000
 * parseDuration('500ms') // 500
 * parseDuration('1.5m')  // 90000
 * parseDuration('1h')    // 3600000
 * parseDuration('bad')   // null
 */
export function parseDuration(str: string): number | null {
    // Match: number (integer or decimal) + optional unit
    const match = str.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
    if (match === null) {
        return null;
    }

    // SAFETY: Handle undefined from noUncheckedIndexedAccess
    const valueStr = match[1];
    if (valueStr === undefined) {
        return null;
    }

    const value = parseFloat(valueStr);
    if (isNaN(value)) {
        return null;
    }

    // Unit defaults to 's' (seconds) if not specified
    const unit = match[2] ?? 's';

    switch (unit) {
        case 'ms':
            return value;
        case 's':
            return value * 1000;
        case 'm':
            return value * 60 * 1000;
        case 'h':
            return value * 60 * 60 * 1000;
        default:
            // SAFETY: This should never happen due to regex, but TypeScript doesn't know
            return null;
    }
}
