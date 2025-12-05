/**
 * cat - Concatenate and display files
 *
 * SYNOPSIS
 * ========
 * cat [OPTIONS] [FILE]...
 *
 * DESCRIPTION
 * ===========
 * The cat utility reads files sequentially, writing their contents to standard output.
 * If no files are specified, cat reads from standard input. The name derives from its
 * function to concatenate files.
 *
 * This implementation follows traditional Unix cat behavior: it reads files in order,
 * outputs their contents line-by-line, and continues processing even if individual
 * files fail to open. When reading from stdin, cat passes through messages unchanged,
 * making it suitable for pipeline composition.
 *
 * Unlike some modern implementations, this version focuses on the core concatenation
 * functionality without flags like -n (number lines) or -v (show non-printing chars).
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: POSIX.1-2017 cat
 * Supported flags: (none - basic mode only)
 * Unsupported flags: -n, -b, -v, -e, -t, -s (simplicity by design)
 * Extensions: Message-based stdin (Monk OS specific)
 *
 * EXIT CODES
 * ==========
 * 0 - Success (all files read successfully)
 * 1 - General error (one or more files failed to read)
 * 2 - Usage error (invalid arguments)
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  consumed - when no files specified, passes through all messages unchanged
 * stdout: sends item({ text }) messages - one per line from files
 *         OR forwards stdin messages unchanged in passthrough mode
 * stderr: item({ text }) - error messages in "cat: filename: message" format
 *
 * EDGE CASES
 * ==========
 * - Empty input: Produces no output (matches GNU behavior)
 * - Missing files: Prints error to stderr, continues with remaining files
 * - Binary data: Decoded as UTF-8, may produce replacement characters
 * - No trailing newline: Output preserves exact file contents
 * - Stdin passthrough: Forwards messages without modification
 *
 * @module rom/bin/cat
 */

// =============================================================================
// IMPORTS
// =============================================================================

// Monk OS syscalls and types
import {
    recv,
    send,
    open,
    read,
    close,
    getcwd,
    println,
    eprintln,
    exit,
    getargs,
    respond,
} from '@os/process';

// Local utilities
import { parseArgs, resolvePath } from '@os/shell';

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
 * POSIX: Catchall for general errors.
 */
const EXIT_FAILURE = 1;

/**
 * Exit code for usage/syntax errors.
 * GNU: Standard for invalid arguments.
 */
const EXIT_USAGE = 2;

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
Usage: cat [OPTIONS] [FILE]...

Concatenate FILE(s) to standard output.
With no FILE, or when FILE is -, read standard input.

Options:
  -h, --help     Display this help and exit

Examples:
  cat file.txt              Display contents of file.txt
  cat file1.txt file2.txt   Display both files in order
  echo "hello" | cat        Pass through stdin
  cat                       Read from stdin until EOF
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

/**
 * Argument specifications for parseArgs().
 */
const ARG_SPECS = {
    help: { short: 'h', long: 'help', desc: 'Display help' },
};

// =============================================================================
// FILE PROCESSING
// =============================================================================

/**
 * Read a file and output its contents line-by-line.
 *
 * ALGORITHM:
 * 1. Open file descriptor for reading
 * 2. Read chunks of bytes using async iterator
 * 3. Decode bytes to text, buffering incomplete characters
 * 4. Split on newlines and output complete lines
 * 5. Flush any remaining buffer at end
 *
 * GNU COMPATIBILITY: Preserves exact file contents including final newline
 * (or lack thereof). Does not add or remove line endings.
 *
 * @param path - Absolute path to file
 * @throws Error if file cannot be opened or read
 */
async function catFile(path: string): Promise<void> {
    const fd = await open(path, { read: true });

    try {
        // POSIX: Decode bytes as UTF-8
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let buffer = '';

        for await (const chunk of read(fd)) {
            // Stream decode: preserve incomplete multi-byte chars
            buffer += decoder.decode(chunk, { stream: true });

            // Split on newlines and output complete lines
            const lines = buffer.split('\n');

            // EDGE: Keep last element (possibly empty) as buffer
            const remaining = lines.pop();

            buffer = remaining !== undefined ? remaining : '';

            for (const line of lines) {
                await println(line);
            }
        }

        // Flush decoder and remaining buffer
        buffer += decoder.decode();
        if (buffer.length > 0) {
            await println(buffer);
        }
    }
    finally {
        // POSIX: Always close file descriptor
        await close(fd);
    }
}

/**
 * Pass through stdin messages unchanged.
 *
 * MONK OS BEHAVIOR: When no files specified, cat acts as a message passthrough.
 * This makes it useful in pipelines for debugging or explicit pass-through.
 *
 * MESSAGE PROTOCOL:
 * - Read Response messages from stdin (fd 0) via recv()
 * - Forward each message to stdout (fd 1) via send()
 * - Loop terminates when 'done' message received
 */
async function passthroughStdin(): Promise<void> {
    for await (const msg of recv(0)) {
        await send(1, msg);
    }
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Entry point for the cat command.
 *
 * ALGORITHM:
 * 1. Parse command-line arguments
 * 2. Display help if requested
 * 3. If no files: passthrough stdin messages
 * 4. Otherwise: process each file in order
 * 5. Exit with appropriate code
 *
 * ERROR HANDLING:
 * - Usage errors: Print to stderr, exit 2
 * - File errors: Print to stderr, continue with remaining files, exit 1
 * - Success: Exit 0
 *
 * GNU BEHAVIOR: Process all files even if some fail. Exit code reflects
 * whether ANY file failed, not just the last one.
 *
 */
export default async function main(): Promise<void> {
    // -------------------------------------------------------------------------
    // Argument Parsing
    // -------------------------------------------------------------------------
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    // Handle parse errors
    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`cat: ${err}`);
        }

        await eprintln(`Try 'cat --help' for more information.`);

        return exit(EXIT_USAGE);
    }

    // Handle unknown flags
    if (parsed.unknown.length > 0) {
        for (const flag of parsed.unknown) {
            await eprintln(`cat: unknown option: ${flag}`);
        }

        await eprintln(`Try 'cat --help' for more information.`);

        return exit(EXIT_USAGE);
    }

    // -------------------------------------------------------------------------
    // Help Display
    // -------------------------------------------------------------------------
    if (parsed.flags.help) {
        await println(HELP_TEXT);

        return exit(EXIT_SUCCESS);
    }

    // -------------------------------------------------------------------------
    // Stdin Passthrough Mode
    // -------------------------------------------------------------------------
    // POSIX: No files means read from stdin
    if (parsed.positional.length === 0) {
        await passthroughStdin();
        await send(1, respond.done());

        return exit(EXIT_SUCCESS);
    }

    // -------------------------------------------------------------------------
    // File Processing Mode
    // -------------------------------------------------------------------------
    const cwd = await getcwd();
    let hadError = false;

    for (const file of parsed.positional) {
        // POSIX: "-" means read from stdin
        if (file === '-') {
            await passthroughStdin();
            continue;
        }

        try {
            // Resolve relative paths against cwd
            const path = resolvePath(cwd, file);

            await catFile(path);
        }
        catch (err) {
            // GNU: Format errors as "cat: filename: message"
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`cat: ${file}: ${msg}`);
            hadError = true;
            // GNU: Continue processing remaining files
        }
    }

    // -------------------------------------------------------------------------
    // Exit
    // -------------------------------------------------------------------------
    // Signal end of stream for downstream commands
    await send(1, respond.done());

    return exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}
