/**
 * head - output the first part of files
 *
 * SYNOPSIS
 * ========
 * head [OPTIONS] [FILE]...
 *
 * DESCRIPTION
 * ===========
 * Print the first N lines of each FILE to standard output. With more than one
 * FILE, precede each with a header giving the file name.
 *
 * With no FILE, or when FILE is -, read standard input.
 *
 * By default, head prints the first 10 lines of each file. The -n option
 * allows specifying a different number of lines.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: POSIX.1-2017 + GNU coreutils 9.0
 * Supported flags: -n (lines count)
 * Unsupported flags: -c (bytes), -q (quiet), -v (verbose headers)
 * Extensions: None
 *
 * EXIT CODES
 * ==========
 * 0 - Success: all files processed successfully
 * 1 - General error: one or more files failed to process
 * 2 - Usage error: invalid command-line arguments
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  consumed (optional) - expects item({ text }) messages when reading from stdin
 * stdout: item({ text }) messages - one per line of output
 * stderr: item({ text }) messages - error messages in "head: file: message" format
 *
 * EDGE CASES
 * ==========
 * - Empty input: produces no output (matches GNU behavior)
 * - Fewer lines than requested: outputs all available lines
 * - Multiple files: continues processing remaining files on error
 * - "-" as filename: reads from stdin, not a file named "-"
 * - File ending with newline: trailing newline not counted as extra line
 *
 * @module rom/bin/head
 */

// =============================================================================
// IMPORTS
// =============================================================================

// Monk OS syscalls and utilities
import {
    getargs,
    getcwd,
    readFile,
    recv,
    send,
    println,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Exit code for successful execution.
 * POSIX: Standard success code.
 */
const EXIT_SUCCESS = 0;

/**
 * Exit code for general errors.
 * POSIX: Catchall for general errors (file not found, permission denied, etc.).
 */
const EXIT_FAILURE = 1;

/**
 * Exit code for usage/syntax errors.
 * GNU: Standard for invalid arguments.
 */
const EXIT_USAGE = 2;

/**
 * Default number of lines to output.
 * GNU: Standard default for head command.
 */
const DEFAULT_LINE_COUNT = 10;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed command-line options.
 *
 * DESIGN: Each flag maps to a clear, typed field.
 * Boolean flags use true/false, not presence/absence.
 */
interface Options {
    /** Show help and exit */
    help: boolean;
    /** Number of lines to output */
    lineCount: number;
    /** Input files (positional arguments) */
    files: string[];
}

/**
 * Default options when no flags provided.
 */
const DEFAULT_OPTIONS: Options = {
    help: false,
    lineCount: DEFAULT_LINE_COUNT,
    files: [],
};

// =============================================================================
// HELP TEXT
// =============================================================================

/**
 * Usage text displayed with --help or on usage error.
 *
 * FORMAT: Follows GNU conventions:
 * - First line: Usage: command [OPTIONS] ARGS
 * - Blank line
 * - Description paragraph
 * - Blank line
 * - Options list (aligned)
 */
const HELP_TEXT = `
Usage: head [OPTIONS] [FILE]...

Print the first 10 lines of each FILE to standard output.
With more than one FILE, precede each with a header giving the file name.

With no FILE, or when FILE is -, read standard input.

Options:
  -n N           Output the first N lines (default: 10)
  -h, --help     Display this help and exit

Examples:
  head /tmp/log.txt             Output first 10 lines of file
  head -n 5 /tmp/log.txt        Output first 5 lines of file
  head -n20 file1.txt file2.txt Output first 20 lines of each file
  cat file.txt | head -n 3      Read from stdin via pipe
  head - < input.txt            Read from stdin explicitly
`.trim();

// =============================================================================
// ARGUMENT PARSING
// =============================================================================

/**
 * Parse command-line arguments.
 *
 * GNU CONVENTIONS:
 * - Single dash + letter: -n
 * - Double dash + word: --help
 * - Combined format: -n10 (no space)
 * - "--" ends flag parsing (remaining args are positional)
 * - "-" as argument means stdin (not a flag)
 *
 * @param args - Raw command-line arguments (including program name at index 0)
 * @returns Parsed options object
 * @throws Never throws - invalid usage is returned as usage error
 */
function parseOptions(args: string[]): Options | { error: string } {
    const opts = { ...DEFAULT_OPTIONS };

    // Skip program name (args[0])
    let i = 1;

    while (i < args.length) {
        const arg = args[i];

        if (arg === undefined) {
            break;
        }

        // "--" ends option parsing
        if (arg === '--') {
            opts.files.push(...args.slice(i + 1));
            break;
        }

        // "-" is stdin, not a flag
        if (arg === '-') {
            opts.files.push('-');
            i++;
            continue;
        }

        // Long options
        if (arg === '--help') {
            opts.help = true;
            i++;
            continue;
        }

        // Short option with separate value: -n N
        if (arg === '-n') {
            const nextArg = args[i + 1];

            if (nextArg === undefined) {
                return { error: "option requires an argument -- 'n'" };
            }

            const count = parseInt(nextArg, 10);

            if (isNaN(count) || count < 0) {
                return { error: `invalid number of lines: '${nextArg}'` };
            }

            opts.lineCount = count;
            i += 2;
            continue;
        }

        // Short option with combined value: -n10
        if (arg.startsWith('-n')) {
            const valueStr = arg.slice(2);
            const count = parseInt(valueStr, 10);

            if (isNaN(count) || count < 0) {
                return { error: `invalid number of lines: '${valueStr}'` };
            }

            opts.lineCount = count;
            i++;
            continue;
        }

        // Short help flag
        if (arg === '-h') {
            opts.help = true;
            i++;
            continue;
        }

        // Unknown flag
        if (arg.startsWith('-')) {
            return { error: `invalid option -- '${arg.slice(1)}'` };
        }

        // Positional argument
        opts.files.push(arg);
        i++;
    }

    return opts;
}

// =============================================================================
// FILE PROCESSING
// =============================================================================

/**
 * Process input from stdin by reading message stream.
 *
 * MESSAGE PROTOCOL: Reads Response messages from fd 0 until 'done' message.
 * Each item({ text }) message is considered one line and forwarded to stdout.
 *
 * @param maxLines - Maximum number of lines to output
 * @returns Promise that resolves when stdin processing completes
 */
async function processStdin(maxLines: number): Promise<void> {
    let count = 0;

    // MONK: recv() yields Response messages until 'done'
    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            // Forward the message to stdout
            await send(1, msg);
            count++;

            // Stop after reaching line limit
            if (count >= maxLines) {
                break;
            }
        }
        // POSIX: Ignore other message types (data, event, etc.)
    }
}

/**
 * Process a single file and output its first N lines.
 *
 * GNU BEHAVIOR: Reads entire file, splits by newline, outputs first N lines.
 * Trailing newlines are handled correctly (not counted as extra empty line).
 *
 * @param cwd - Current working directory for path resolution
 * @param file - File path (relative or absolute)
 * @param maxLines - Maximum number of lines to output
 * @returns EXIT_SUCCESS on success, EXIT_FAILURE on error
 */
async function processFile(cwd: string, file: string, maxLines: number): Promise<number> {
    const path = resolvePath(cwd, file);

    try {
        // Read entire file content
        const content = await readFile(path);

        // Split into lines
        const allLines = content.split('\n');

        // EDGE: Remove trailing empty element if content ends with newline
        // This matches GNU behavior: "foo\nbar\n" is 2 lines, not 3
        const lastLine = allLines[allLines.length - 1];

        if (lastLine !== undefined && lastLine === '') {
            allLines.pop();
        }

        // Output first N lines
        const output = allLines.slice(0, maxLines);

        for (const line of output) {
            await println(line);
        }

        return EXIT_SUCCESS;
    }
    catch (err) {
        // GNU: Format errors as "head: file: message"
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`head: ${file}: ${msg}`);

        return EXIT_FAILURE;
    }
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Entry point for the head command.
 *
 * ALGORITHM:
 * 1. Parse command-line arguments
 * 2. Handle --help flag
 * 3. Process each input (files or stdin)
 * 4. Exit with appropriate code
 *
 * ERROR HANDLING:
 * - Usage errors: Print to stderr, exit 2
 * - File errors: Print to stderr, continue processing, exit 1 at end
 * - Success: Exit 0
 *
 * @param args - Command-line arguments from process
 */
export default async function main(args: string[]): Promise<void> {
    // -------------------------------------------------------------------------
    // Argument Parsing
    // -------------------------------------------------------------------------
    const parsed = parseOptions(args);

    // Handle parse errors
    if ('error' in parsed) {
        await eprintln(`head: ${parsed.error}`);
        await eprintln("Try 'head --help' for more information.");

        return exit(EXIT_USAGE);
    }

    const opts = parsed;

    // -------------------------------------------------------------------------
    // Help Text
    // -------------------------------------------------------------------------
    if (opts.help) {
        await println(HELP_TEXT);

        return exit(EXIT_SUCCESS);
    }

    // -------------------------------------------------------------------------
    // Input Processing
    // -------------------------------------------------------------------------

    // POSIX: No files specified means read from stdin
    if (opts.files.length === 0) {
        await processStdin(opts.lineCount);

        return exit(EXIT_SUCCESS);
    }

    // GNU: Multiple files get headers, single file doesn't
    const showHeaders = opts.files.length > 1;
    let hadError = false;

    for (let i = 0; i < opts.files.length; i++) {
        const file = opts.files[i];

        if (file === undefined) {
            continue;
        }

        // Show header for multiple files
        if (showHeaders) {
            if (i > 0) {
                await println('');
            }

            // POSIX: "-" is displayed as "standard input" in headers
            const displayName = file === '-' ? 'standard input' : file;

            await println(`==> ${displayName} <==`);
        }

        // Process stdin or file
        if (file === '-') {
            await processStdin(opts.lineCount);
        }
        else {
            const cwd = await getcwd();
            const exitCode = await processFile(cwd, file, opts.lineCount);

            if (exitCode !== EXIT_SUCCESS) {
                hadError = true;
                // GNU: Continue processing remaining files
            }
        }
    }

    // GNU: Exit code reflects whether ANY file failed
    return exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}

// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Bootstrap the main function with error handling.
 *
 * DESIGN: Catch any unhandled errors and report them properly.
 * This ensures no uncaught promise rejections.
 */
getargs()
    .then(args => main(args))
    .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`head: ${msg}`);
        await exit(EXIT_FAILURE);
    });
