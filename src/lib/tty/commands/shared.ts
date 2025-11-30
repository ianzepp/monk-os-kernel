/**
 * Shared types and helpers for TTY commands
 */

import type { FS, FSEntry } from '@src/lib/fs/index.js';
import type { Session, CommandIO } from '../types.js';

/**
 * Argument specification for parseArgs()
 */
export type ArgSpec = {
    /** Short flag (e.g., 'l' for -l) */
    short?: string;
    /** Long flag (e.g., 'long' for --long) */
    long?: string;
    /** Flag takes a value (e.g., -n 10 or --count=10) */
    value?: boolean;
    /** Value is required (error if flag present without value) */
    required?: boolean;
    /** Default value if flag not provided */
    default?: string | boolean;
    /** Description for help text */
    desc?: string;
};

/**
 * Result from parseArgs()
 */
export type ParsedArgs = {
    /** Flag values (boolean for flags, string for value flags) */
    flags: Record<string, string | boolean>;
    /** Positional arguments (non-flag tokens) */
    positional: string[];
    /** Unknown flags encountered */
    unknown: string[];
    /** Parse errors */
    errors: string[];
};

/**
 * Parse command-line arguments
 *
 * Features:
 * - Combined short flags: -la → -l -a
 * - Short flags with values: -n10, -n 10
 * - Long flags with values: --count=10, --count 10
 * - Positional args after flags or after --
 * - Unknown flag detection
 *
 * @param args - Raw argument array
 * @param specs - Argument specifications
 * @returns Parsed arguments
 *
 * @example
 * const result = parseArgs(['-la', '-n', '10', 'file.txt'], {
 *     l: { short: 'l', desc: 'Long format' },
 *     a: { short: 'a', desc: 'Show all' },
 *     n: { short: 'n', value: true, desc: 'Line count' },
 * });
 * // result.flags = { l: true, a: true, n: '10' }
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

    // Build lookup maps
    const shortMap = new Map<string, string>(); // -l → spec key
    const longMap = new Map<string, string>();  // --long → spec key

    for (const [key, spec] of Object.entries(specs)) {
        if (spec.short) shortMap.set(spec.short, key);
        if (spec.long) longMap.set(spec.long, key);
        // Apply defaults
        if (spec.default !== undefined) {
            result.flags[key] = spec.default;
        }
    }

    let i = 0;
    let positionalOnly = false;

    while (i < args.length) {
        const arg = args[i];

        // After --, everything is positional
        if (arg === '--') {
            positionalOnly = true;
            i++;
            continue;
        }

        if (positionalOnly || !arg.startsWith('-') || arg === '-') {
            result.positional.push(arg);
            i++;
            continue;
        }

        // Long flag: --flag or --flag=value
        if (arg.startsWith('--')) {
            const eqIndex = arg.indexOf('=');
            let flagName: string;
            let flagValue: string | undefined;

            if (eqIndex !== -1) {
                flagName = arg.slice(2, eqIndex);
                flagValue = arg.slice(eqIndex + 1);
            } else {
                flagName = arg.slice(2);
            }

            const specKey = longMap.get(flagName);
            if (!specKey) {
                result.unknown.push(arg);
                i++;
                continue;
            }

            const spec = specs[specKey];
            if (spec.value) {
                if (flagValue !== undefined) {
                    result.flags[specKey] = flagValue;
                } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                    result.flags[specKey] = args[++i];
                } else if (spec.required) {
                    result.errors.push(`--${flagName} requires a value`);
                } else {
                    result.flags[specKey] = true;
                }
            } else {
                result.flags[specKey] = true;
            }
            i++;
            continue;
        }

        // Short flags: -l, -la, -n10, -n 10
        const shortFlags = arg.slice(1);
        let j = 0;

        while (j < shortFlags.length) {
            const char = shortFlags[j];
            const specKey = shortMap.get(char);

            if (!specKey) {
                result.unknown.push(`-${char}`);
                j++;
                continue;
            }

            const spec = specs[specKey];
            if (spec.value) {
                // Rest of this arg is the value, or next arg
                const rest = shortFlags.slice(j + 1);
                if (rest) {
                    result.flags[specKey] = rest;
                    break; // Consumed rest of arg
                } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                    result.flags[specKey] = args[++i];
                } else if (spec.required) {
                    result.errors.push(`-${char} requires a value`);
                } else {
                    result.flags[specKey] = true;
                }
                j++;
            } else {
                result.flags[specKey] = true;
                j++;
            }
        }
        i++;
    }

    return result;
}

/**
 * Command handler signature
 *
 * Commands receive:
 * - session: User session context
 * - fs: Virtual filesystem (null for commands that don't need it)
 * - args: Command arguments (already variable-expanded)
 * - io: Standard I/O streams (stdin, stdout, stderr)
 *
 * Returns exit code (0 = success, non-zero = error)
 */
export type CommandHandler = (
    session: Session,
    fs: FS | null,
    args: string[],
    io: CommandIO
) => Promise<number>;

/**
 * Format mode as permission string
 */
export function formatMode(type: string, mode: number): string {
    const typeChar = type === 'directory' ? 'd' : type === 'symlink' ? 'l' : '-';

    const perms = [
        (mode & 0o400) ? 'r' : '-',
        (mode & 0o200) ? 'w' : '-',
        (mode & 0o100) ? 'x' : '-',
        (mode & 0o040) ? 'r' : '-',
        (mode & 0o020) ? 'w' : '-',
        (mode & 0o010) ? 'x' : '-',
        (mode & 0o004) ? 'r' : '-',
        (mode & 0o002) ? 'w' : '-',
        (mode & 0o001) ? 'x' : '-',
    ].join('');

    return typeChar + perms;
}

/**
 * Parse duration string into milliseconds
 * Supports: 5 (seconds), 5s, 500ms, 1m, 1h
 */
export function parseDuration(str: string): number | null {
    const match = str.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
    if (!match) return null;

    const value = parseFloat(match[1]);
    const unit = match[2] || 's';

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
            return null;
    }
}

/**
 * Format entry for ls output
 */
export function formatEntry(entry: FSEntry, long: boolean): string {
    const suffix = entry.type === 'directory' ? '/' : '';

    if (!long) {
        return entry.name + suffix;
    }

    const mode = formatMode(entry.type, entry.mode);
    const size = String(entry.size).padStart(8);
    const date = entry.mtime
        ? entry.mtime.toISOString().slice(0, 10)
        : '          ';

    return `${mode}  ${size}  ${date}  ${entry.name}${suffix}`;
}
