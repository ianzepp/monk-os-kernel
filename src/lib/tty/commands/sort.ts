/**
 * sort - Sort lines of text
 *
 * Usage:
 *   sort [options] [file...]
 *   <input> | sort [options]
 *
 * Options:
 *   -r              Reverse sort order
 *   -n              Numeric sort
 *   -u              Remove duplicate lines
 *   -f              Fold case (case-insensitive)
 *   -b              Ignore leading blanks
 *   -d              Dictionary order (only alphanumeric + space)
 *   -h              Human numeric sort (2K, 1G, etc.)
 *   -k <key>        Sort by field (e.g., -k2 or -k2,3)
 *   -t <sep>        Field separator (default: whitespace)
 *   -o <file>       Write to file instead of stdout
 *   -c              Check if sorted, exit 1 if not
 *   -m              Merge already sorted files
 *   -s              Stable sort (preserve order of equal elements)
 *
 * Examples:
 *   sort file.txt                Sort lines alphabetically
 *   sort -n numbers.txt          Sort numerically
 *   sort -u file.txt             Sort and remove duplicates
 *   sort -t: -k3 /etc/passwd     Sort by field 3, colon-separated
 *   ls -l | sort -k5 -n          Sort by file size
 *   sort -rn scores.txt          Reverse numeric sort
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    reverse: { short: 'r', desc: 'Reverse order' },
    numeric: { short: 'n', desc: 'Numeric sort' },
    unique: { short: 'u', desc: 'Remove duplicates' },
    ignoreCase: { short: 'f', desc: 'Case-insensitive' },
    ignoreBlanks: { short: 'b', desc: 'Ignore leading blanks' },
    dictionary: { short: 'd', desc: 'Dictionary order' },
    human: { short: 'h', desc: 'Human numeric sort' },
    key: { short: 'k', value: true, desc: 'Sort key' },
    separator: { short: 't', value: true, desc: 'Field separator' },
    output: { short: 'o', value: true, desc: 'Output file' },
    check: { short: 'c', desc: 'Check sorted' },
    merge: { short: 'm', desc: 'Merge sorted files' },
    stable: { short: 's', desc: 'Stable sort' },
};

type SortOptions = {
    reverse: boolean;
    numeric: boolean;
    unique: boolean;
    ignoreCase: boolean;
    ignoreBlanks: boolean;
    dictionary: boolean;
    human: boolean;
    key: { start: number; end: number | null } | null;
    separator: string | null;
    output: string | null;
    check: boolean;
    stable: boolean;
};

/**
 * Parse human-readable size (1K, 2M, 3G)
 */
function parseHumanSize(str: string): number {
    const match = str.match(/^([\d.]+)\s*([KMGTPE])?i?[Bb]?$/i);
    if (!match) return parseFloat(str) || 0;

    const num = parseFloat(match[1]);
    const unit = (match[2] || '').toUpperCase();
    const multipliers: Record<string, number> = {
        '': 1,
        'K': 1024,
        'M': 1024 ** 2,
        'G': 1024 ** 3,
        'T': 1024 ** 4,
        'P': 1024 ** 5,
        'E': 1024 ** 6,
    };

    return num * (multipliers[unit] || 1);
}

/**
 * Parse key specification (e.g., "2" or "2,3" or "2.1,3.2")
 */
function parseKeySpec(spec: string): { start: number; end: number | null } | null {
    const match = spec.match(/^(\d+)(?:,(\d+))?$/);
    if (!match) return null;

    return {
        start: parseInt(match[1], 10),
        end: match[2] ? parseInt(match[2], 10) : null,
    };
}

/**
 * Extract sort key from line based on field specification
 */
function extractKey(line: string, options: SortOptions): string {
    if (!options.key) return line;

    const sep = options.separator || /\s+/;
    const fields = line.split(sep);
    const start = options.key.start - 1; // 1-indexed to 0-indexed
    const end = options.key.end !== null ? options.key.end : start + 1;

    if (start < 0 || start >= fields.length) return '';

    return fields.slice(start, end).join(' ');
}

/**
 * Normalize line for comparison based on options
 */
function normalizeForCompare(line: string, options: SortOptions): string {
    let result = line;

    if (options.ignoreBlanks) {
        result = result.trimStart();
    }

    if (options.dictionary) {
        result = result.replace(/[^a-zA-Z0-9\s]/g, '');
    }

    if (options.ignoreCase) {
        result = result.toLowerCase();
    }

    return result;
}

/**
 * Compare two lines based on options
 */
function compareLines(a: string, b: string, options: SortOptions): number {
    const keyA = extractKey(a, options);
    const keyB = extractKey(b, options);
    const normA = normalizeForCompare(keyA, options);
    const normB = normalizeForCompare(keyB, options);

    let result: number;

    if (options.human) {
        const numA = parseHumanSize(normA);
        const numB = parseHumanSize(normB);
        result = numA - numB;
    } else if (options.numeric) {
        const numA = parseFloat(normA) || 0;
        const numB = parseFloat(normB) || 0;
        result = numA - numB;
    } else {
        result = normA.localeCompare(normB);
    }

    return options.reverse ? -result : result;
}

/**
 * Check if lines are sorted
 */
function checkSorted(lines: string[], options: SortOptions): boolean {
    for (let i = 1; i < lines.length; i++) {
        if (compareLines(lines[i - 1], lines[i], options) > 0) {
            return false;
        }
    }
    return true;
}

export const sort: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`sort: ${err}\n`);
        }
        return 1;
    }

    // Parse key specification
    let key: { start: number; end: number | null } | null = null;
    if (typeof parsed.flags.key === 'string') {
        key = parseKeySpec(parsed.flags.key);
        if (!key) {
            io.stderr.write(`sort: invalid key specification: ${parsed.flags.key}\n`);
            return 1;
        }
    }

    const options: SortOptions = {
        reverse: Boolean(parsed.flags.reverse),
        numeric: Boolean(parsed.flags.numeric),
        unique: Boolean(parsed.flags.unique),
        ignoreCase: Boolean(parsed.flags.ignoreCase),
        ignoreBlanks: Boolean(parsed.flags.ignoreBlanks),
        dictionary: Boolean(parsed.flags.dictionary),
        human: Boolean(parsed.flags.human),
        key,
        separator: typeof parsed.flags.separator === 'string' ? parsed.flags.separator : null,
        output: typeof parsed.flags.output === 'string' ? parsed.flags.output : null,
        check: Boolean(parsed.flags.check),
        stable: Boolean(parsed.flags.stable),
    };

    const files = parsed.positional;

    // Read content from files or stdin
    let content: string;

    if (files.length === 0) {
        // Read from stdin
        let buffer = '';
        for await (const chunk of io.stdin) {
            buffer += chunk.toString();
        }
        content = buffer;
    } else {
        // Read from files
        const parts: string[] = [];
        for (const file of files) {
            if (!fs) {
                io.stderr.write('sort: filesystem not available\n');
                return 1;
            }
            const resolved = resolvePath(session.cwd, file);
            try {
                const data = await fs.read(resolved);
                parts.push(data.toString());
            } catch (err) {
                if (err instanceof FSError) {
                    io.stderr.write(`sort: ${file}: ${err.message}\n`);
                    return 1;
                }
                throw err;
            }
        }
        content = parts.join('');
    }

    // Split into lines
    let lines = content.split('\n');

    // Remove trailing empty line if content ends with newline
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }

    // Check mode
    if (options.check) {
        if (checkSorted(lines, options)) {
            return 0;
        }
        io.stderr.write('sort: input is not sorted\n');
        return 1;
    }

    // Sort (using stable sort if requested by creating indices)
    if (options.stable) {
        const indexed = lines.map((line, i) => ({ line, index: i }));
        indexed.sort((a, b) => {
            const cmp = compareLines(a.line, b.line, options);
            return cmp !== 0 ? cmp : a.index - b.index;
        });
        lines = indexed.map(x => x.line);
    } else {
        lines.sort((a, b) => compareLines(a, b, options));
    }

    // Unique
    if (options.unique) {
        const seen = new Set<string>();
        lines = lines.filter(line => {
            const key = options.ignoreCase ? line.toLowerCase() : line;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    // Output
    const output = lines.map(l => l + '\n').join('');

    if (options.output) {
        const resolved = resolvePath(session.cwd, options.output);
        try {
            await fs!.write(resolved, Buffer.from(output));
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`sort: ${options.output}: ${err.message}\n`);
                return 1;
            }
            throw err;
        }
    } else {
        io.stdout.write(output);
    }

    return 0;
};
