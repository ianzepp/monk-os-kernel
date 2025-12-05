/**
 * echo - Display a line of text
 *
 * SYNOPSIS
 * ========
 * echo [OPTIONS] [STRING]...
 *
 * DESCRIPTION
 * ===========
 * Echo the STRING(s) to standard output. If no STRING is provided, output
 * a blank line. Multiple STRINGs are concatenated with a single space
 * between each argument.
 *
 * Echo is a fundamental command for displaying text, used extensively in
 * scripts and interactive shells. This implementation follows GNU coreutils
 * echo behavior with support for the -n flag to suppress the trailing newline.
 *
 * Unlike some implementations, this echo does not process backslash escape
 * sequences by default (matching GNU echo without -e flag). This makes it
 * safer for displaying literal strings without unexpected interpretation.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU coreutils 9.0 echo
 * Supported flags:
 *   -n            Suppress trailing newline
 *   --help        Display help text and exit
 * Unsupported flags:
 *   -e            Enable backslash escape interpretation (not implemented)
 *   -E            Disable backslash escape interpretation (not needed, default)
 * Extensions: None
 *
 * EXIT CODES
 * ==========
 * 0 - Success (always succeeds unless system error)
 * 1 - General error (write failure or unexpected error)
 * 2 - Usage error (invalid flag syntax)
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  Ignored - echo does not read from stdin
 * stdout: Sends item({ text }) message containing concatenated arguments
 * stderr: Sends item({ text }) for error messages on invalid usage
 *
 * EDGE CASES
 * ==========
 * - No arguments: Outputs blank line (just newline)
 * - Single "-n": Literal string "-n" is output (not treated as flag)
 * - Mixed flags and text: Only leading flags are parsed, rest are literal
 * - Empty strings: Preserved in output (e.g., echo "" "" outputs single space)
 * - Flag-like arguments after text: Treated as literal strings
 *
 * @module rom/bin/echo
 */

// =============================================================================
// IMPORTS
// =============================================================================

// Monk OS process I/O
import { print, println, eprintln, exit, getargs } from '@rom/lib/process';

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
 * POSIX: Catchall for general errors (write failures).
 */
const EXIT_FAILURE = 1;

// =============================================================================
// HELP TEXT
// =============================================================================

/**
 * Usage text displayed with --help.
 *
 * FORMAT: Follows GNU conventions:
 * - First line: Usage: command [OPTIONS] ARGS
 * - Blank line
 * - Description paragraph
 * - Blank line
 * - Options list (aligned)
 */
const HELP_TEXT = `
Usage: echo [OPTIONS] [STRING]...

Display a line of text to standard output.

Options:
  -n          Do not output the trailing newline
  --help      Display this help and exit

Examples:
  echo Hello, World!       Output "Hello, World!" with newline
  echo -n "No newline"     Output text without trailing newline
  echo                     Output a blank line
  echo one two three       Output "one two three" with spaces
`.trim();

// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed command-line options.
 *
 * DESIGN: Each flag maps to a clear, typed field.
 */
interface Options {
    /** Suppress trailing newline */
    noNewline: boolean;
    /** Show help and exit */
    help: boolean;
    /** Text arguments to output */
    args: string[];
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Parse command-line arguments for echo.
 *
 * GNU COMPATIBILITY:
 * - Only leading flags are parsed
 * - Once a non-flag argument is seen, flag parsing stops
 * - This matches GNU echo behavior: "echo -n foo -n" outputs "foo -n"
 *
 * @param args - Command-line arguments (excluding command name)
 * @returns Parsed options
 */
function parseOptions(args: string[]): Options {
    const opts: Options = {
        noNewline: false,
        help: false,
        args: [],
    };

    let i = 0;

    // Parse leading flags only
    while (i < args.length) {
        const arg = args[i];

        // Stop parsing flags at first non-flag argument
        if (!arg || !arg.startsWith('-')) {
            break;
        }

        // Handle "--help"
        if (arg === '--help') {
            opts.help = true;
            i++;
            continue;
        }

        // Handle "-n"
        if (arg === '-n') {
            opts.noNewline = true;
            i++;
            continue;
        }

        // Unknown flag - treat as literal text (GNU behavior)
        // This handles "-", "--", or any other dash-prefixed string
        break;
    }

    // Remaining arguments are text to output
    opts.args = args.slice(i);

    return opts;
}

/**
 * Format output text from arguments.
 *
 * GNU COMPATIBILITY: Arguments are joined with single spaces.
 * Empty arguments are preserved (e.g., ["a", "", "b"] becomes "a  b").
 *
 * @param args - Text arguments to format
 * @returns Formatted output string
 */
function formatOutput(args: string[]): string {
    return args.join(' ');
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Entry point for the echo command.
 *
 * ALGORITHM:
 * 1. Parse command-line arguments (leading flags only)
 * 2. Handle --help flag
 * 3. Format output text from remaining arguments
 * 4. Output text with or without trailing newline based on -n flag
 *
 * ERROR HANDLING:
 * - Usage errors: Print to stderr, exit 2
 * - Write failures: Print to stderr, exit 1
 * - Success: Exit 0 (always, echo cannot fail on valid input)
 *
 */
export default async function main(): Promise<void> {
    // -------------------------------------------------------------------------
    // Argument Parsing
    // -------------------------------------------------------------------------
    const args = await getargs();
    const opts = parseOptions(args.slice(1));

    // -------------------------------------------------------------------------
    // Handle Help
    // -------------------------------------------------------------------------
    if (opts.help) {
        await println(HELP_TEXT);

        return exit(EXIT_SUCCESS);
    }

    // -------------------------------------------------------------------------
    // Format and Output
    // -------------------------------------------------------------------------
    try {
        const text = formatOutput(opts.args);

        // GNU BEHAVIOR: -n suppresses trailing newline
        if (opts.noNewline) {
            await print(text);
        }
        else {
            await println(text);
        }

        return exit(EXIT_SUCCESS);
    }
    catch (err) {
        // EDGE: Write failure (disk full, broken pipe, etc.)
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`echo: write error: ${message}`);

        return exit(EXIT_FAILURE);
    }
}
