/**
 * sort - sort lines of text
 *
 * SYNOPSIS
 * ========
 * sort [OPTIONS] [FILE]...
 *
 * DESCRIPTION
 * ===========
 * Sort lines of text from FILE(s) or standard input, writing the result to
 * standard output. With no FILE, or when FILE is -, read standard input.
 *
 * By default, sort uses locale-aware string comparison. Various options
 * modify the comparison algorithm (numeric, human-readable, dictionary)
 * and output behavior (unique, reverse, stable).
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU coreutils sort
 * Supported flags: -r, -n, -u, -f, -b, -d, -h, -k, -t, -o, -c, -s
 * Unsupported flags: -m (merge), -z (zero-terminated), --parallel
 * Extensions: None
 *
 * EXIT CODES
 * ==========
 * 0 - Success (or input is sorted when -c is used)
 * 1 - Disorder found (with -c) or general error
 * 2 - Usage error (invalid arguments)
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  Consumed when no files specified or FILE is "-"
 *         Expects item({ text }) messages, one per line
 * stdout: Emits item({ text }) messages, one per sorted line
 *         Sends done() after all output
 * stderr: Error messages via item({ text })
 *
 * EDGE CASES
 * ==========
 * - Empty input: Produces no output (just done)
 * - Binary data: Treated as text, may produce unexpected results
 * - Missing files: Error message, continues with remaining files
 * - Multiple files: Concatenated before sorting
 *
 * @module rom/bin/sort
 */

// =============================================================================
// IMPORTS
// =============================================================================

import type { Response } from '@rom/lib/process/index.js';
import {
    getargs,
    getcwd,
    open,
    readFile,
    write,
    close,
    recv,
    send,
    println,
    eprintln,
    exit,
    respond,
} from '@rom/lib/process/index.js';
import { parseArgs, resolvePath } from '@rom/lib/shell';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Exit code for successful execution. */
const EXIT_SUCCESS = 0;

/** Exit code for general errors or disorder found with -c. */
const EXIT_FAILURE = 1;

/** Exit code for usage/syntax errors. */
const EXIT_USAGE = 2;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed command-line options.
 */
interface SortOptions {
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
}

/**
 * Item with original message and extracted text for sorting.
 */
interface SortItem {
    msg: Response;
    text: string;
}

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: sort [OPTIONS] [FILE]...

Sort lines of text from FILE(s) or standard input.

Options:
  -r, --reverse        Reverse sort order
  -n, --numeric        Sort numerically
  -u, --unique         Remove duplicate lines
  -f, --ignore-case    Fold case (case-insensitive)
  -b, --ignore-blanks  Ignore leading blanks
  -d, --dictionary     Dictionary order (alphanumeric + space only)
  -h, --human          Human numeric sort (2K, 1G, etc.)
  -k KEY               Sort by field (e.g., -k2 or -k2,3)
  -t SEP               Field separator (default: whitespace)
  -o FILE              Write to FILE instead of stdout
  -c, --check          Check if sorted, exit 1 if not
  -s, --stable         Stable sort (preserve order of equal elements)
      --help           Display this help and exit

With no FILE, or when FILE is -, read standard input.

Examples:
  sort file.txt                Sort alphabetically
  sort -n numbers.txt          Sort numerically
  sort -u file.txt             Sort and remove duplicates
  sort -t: -k3 /etc/passwd     Sort by field 3, colon-separated
  sort -rn scores.txt          Reverse numeric sort
  cat data | sort -            Read from stdin explicitly
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    help: { long: 'help', desc: 'Display help' },
    reverse: { short: 'r', long: 'reverse', desc: 'Reverse order' },
    numeric: { short: 'n', long: 'numeric', desc: 'Numeric sort' },
    unique: { short: 'u', long: 'unique', desc: 'Remove duplicates' },
    ignoreCase: { short: 'f', long: 'ignore-case', desc: 'Case-insensitive' },
    ignoreBlanks: { short: 'b', long: 'ignore-blanks', desc: 'Ignore leading blanks' },
    dictionary: { short: 'd', long: 'dictionary', desc: 'Dictionary order' },
    human: { short: 'h', long: 'human', desc: 'Human numeric sort' },
    key: { short: 'k', value: true, desc: 'Sort key' },
    separator: { short: 't', value: true, desc: 'Field separator' },
    output: { short: 'o', value: true, desc: 'Output file' },
    check: { short: 'c', long: 'check', desc: 'Check sorted' },
    stable: { short: 's', long: 'stable', desc: 'Stable sort' },
};

// =============================================================================
// MAIN
// =============================================================================

/**
 * Entry point for the sort command.
 *
 * ALGORITHM:
 * 1. Parse command-line arguments
 * 2. Collect all input (sort cannot stream - must buffer everything)
 * 3. Sort the collected items
 * 4. Apply unique filter if requested
 * 5. Output sorted items one by one
 *
 * WHY BUFFERING: Sort fundamentally cannot produce output until all input
 * is received, unlike filter commands (grep, sed) that can stream.
 */
export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    // -------------------------------------------------------------------------
    // Help
    // -------------------------------------------------------------------------

    if (parsed.flags.help) {
        await println(HELP_TEXT);
        return exit(EXIT_SUCCESS);
    }

    // -------------------------------------------------------------------------
    // Argument Validation
    // -------------------------------------------------------------------------

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`sort: ${err}`);
        }

        return exit(EXIT_USAGE);
    }

    // Parse key specification
    let key: { start: number; end: number | null } | null = null;

    if (typeof parsed.flags.key === 'string') {
        key = parseKeySpec(parsed.flags.key);

        if (!key) {
            await eprintln(`sort: invalid key specification: ${parsed.flags.key}`);
            return exit(EXIT_USAGE);
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
    const cwd = await getcwd();

    // -------------------------------------------------------------------------
    // Input Collection
    // -------------------------------------------------------------------------

    // WHY: Sort must buffer all input before producing output.
    // Unlike grep/sed, we cannot stream incrementally.
    let items: SortItem[] = [];
    let hadError = false;

    if (files.length === 0) {
        // No files specified - read from stdin
        items = await collectFromStdin();
    }
    else {
        // Process files, treating "-" as stdin
        for (const file of files) {
            if (file === '-') {
                // POSIX: "-" means read from stdin
                const stdinItems = await collectFromStdin();
                items.push(...stdinItems);
            }
            else {
                const fileItems = await collectFromFile(cwd, file);

                if (fileItems === null) {
                    hadError = true;
                    // GNU: Continue processing remaining files
                }
                else {
                    items.push(...fileItems);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Check Mode
    // -------------------------------------------------------------------------

    if (options.check) {
        const lines = items.map(i => i.text);

        if (checkSorted(lines, options)) {
            return exit(EXIT_SUCCESS);
        }

        await eprintln('sort: input is not sorted');
        return exit(EXIT_FAILURE);
    }

    // If we had errors reading files, exit now (after check mode)
    if (hadError && items.length === 0) {
        return exit(EXIT_FAILURE);
    }

    // -------------------------------------------------------------------------
    // Sorting
    // -------------------------------------------------------------------------

    if (options.stable) {
        // STABLE: Preserve original order for equal elements
        const indexed = items.map((item, i) => ({ item, index: i }));

        indexed.sort((a, b) => {
            const cmp = compareLines(a.item.text, b.item.text, options);

            // WHY: Fall back to original index for stable sort
            return cmp !== 0 ? cmp : a.index - b.index;
        });

        items = indexed.map(x => x.item);
    }
    else {
        items.sort((a, b) => compareLines(a.text, b.text, options));
    }

    // -------------------------------------------------------------------------
    // Unique Filter
    // -------------------------------------------------------------------------

    if (options.unique) {
        const seen = new Set<string>();

        items = items.filter(item => {
            const uniqueKey = options.ignoreCase ? item.text.toLowerCase() : item.text;

            if (seen.has(uniqueKey)) {
                return false;
            }

            seen.add(uniqueKey);
            return true;
        });
    }

    // -------------------------------------------------------------------------
    // Output
    // -------------------------------------------------------------------------

    if (options.output) {
        await writeToFile(cwd, options.output, items);
    }
    else {
        // Stream output line by line
        for (const item of items) {
            await send(1, item.msg);
        }

        // Signal end of stream for downstream commands
        await send(1, respond.done());
    }

    return exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}

// =============================================================================
// INPUT COLLECTION
// =============================================================================

/**
 * Collect all items from stdin until done message.
 *
 * WHY: recv(0) yields Response messages until a terminal op (done/error/ok).
 * We only process 'item' messages, ignoring others.
 *
 * PROTOCOL: Each message should contain one line. Line-oriented producers
 * (echo, cat, etc.) are responsible for sending one message per line.
 */
async function collectFromStdin(): Promise<SortItem[]> {
    const items: SortItem[] = [];

    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const data = msg.data as { text?: string } | undefined;
            const text = (data?.text ?? '').replace(/\n$/, '');

            items.push({ msg, text });
        }
    }

    return items;
}

/**
 * Read file content and convert to sort items.
 *
 * @returns Array of items, or null on error
 */
async function collectFromFile(cwd: string, file: string): Promise<SortItem[] | null> {
    const path = resolvePath(cwd, file);

    try {
        const content = await readFile(path);
        const lines = content.split('\n');

        // EDGE: Remove empty last element from trailing newline
        const lastLine = lines[lines.length - 1];
        if (lastLine !== undefined && lastLine === '') {
            lines.pop();
        }

        return lines.map(text => ({
            msg: respond.item({ text: text + '\n' }),
            text,
        }));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`sort: ${file}: ${msg}`);
        return null;
    }
}

// =============================================================================
// OUTPUT
// =============================================================================

/**
 * Write sorted items to output file.
 */
async function writeToFile(cwd: string, outputPath: string, items: SortItem[]): Promise<void> {
    const path = resolvePath(cwd, outputPath);

    try {
        const fd = await open(path, { write: true, create: true, truncate: true });

        try {
            const output = items.map(i => i.text + '\n').join('');
            await write(fd, new TextEncoder().encode(output));
        }
        finally {
            await close(fd);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`sort: ${outputPath}: ${msg}`);
        await exit(EXIT_FAILURE);
    }
}

// =============================================================================
// KEY PARSING
// =============================================================================

/**
 * Parse key specification like "2" or "2,4".
 *
 * GNU FORMAT: -k KEYDEF where KEYDEF is F[.C][OPTS][,F[.C][OPTS]]
 * We support simplified F[,F] format.
 */
function parseKeySpec(spec: string): { start: number; end: number | null } | null {
    const match = spec.match(/^(\d+)(?:,(\d+))?$/);

    if (!match || match[1] === undefined) {
        return null;
    }

    return {
        start: parseInt(match[1], 10),
        end: match[2] !== undefined ? parseInt(match[2], 10) : null,
    };
}

// =============================================================================
// COMPARISON
// =============================================================================

/**
 * Parse human-readable size like "2K", "1.5G".
 *
 * GNU: Supports K, M, G, T, P, E (powers of 1024)
 */
function parseHumanSize(str: string): number {
    const match = str.match(/^([\d.]+)\s*([KMGTPE])?i?[Bb]?$/i);

    if (!match || match[1] === undefined) {
        return parseFloat(str) || 0;
    }

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
 * Extract sort key from line based on field specification.
 */
function extractKey(line: string, options: SortOptions): string {
    if (!options.key) {
        return line;
    }

    const sep = options.separator || /\s+/;
    const fields = line.split(sep);
    const start = options.key.start - 1;
    const end = options.key.end !== null ? options.key.end : start + 1;

    if (start < 0 || start >= fields.length) {
        return '';
    }

    return fields.slice(start, end).join(' ');
}

/**
 * Normalize line for comparison based on options.
 */
function normalizeForCompare(line: string, options: SortOptions): string {
    let result = line;

    if (options.ignoreBlanks) {
        result = result.trimStart();
    }

    if (options.dictionary) {
        // GNU: Only blanks and alphanumeric characters
        result = result.replace(/[^a-zA-Z0-9\s]/g, '');
    }

    if (options.ignoreCase) {
        result = result.toLowerCase();
    }

    return result;
}

/**
 * Compare two lines for sorting.
 *
 * @returns Negative if a < b, positive if a > b, zero if equal
 */
function compareLines(a: string, b: string, options: SortOptions): number {
    const keyA = extractKey(a, options);
    const keyB = extractKey(b, options);
    const normA = normalizeForCompare(keyA, options);
    const normB = normalizeForCompare(keyB, options);

    let result: number;

    if (options.human) {
        result = parseHumanSize(normA) - parseHumanSize(normB);
    }
    else if (options.numeric) {
        result = (parseFloat(normA) || 0) - (parseFloat(normB) || 0);
    }
    else {
        result = normA.localeCompare(normB);
    }

    return options.reverse ? -result : result;
}

/**
 * Check if lines are already sorted.
 */
function checkSorted(lines: string[], options: SortOptions): boolean {
    for (let i = 1; i < lines.length; i++) {
        const prev = lines[i - 1];
        const curr = lines[i];

        if (prev !== undefined && curr !== undefined && compareLines(prev, curr, options) > 0) {
            return false;
        }
    }

    return true;
}
