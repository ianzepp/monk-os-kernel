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
 * stdout: Sends one item({ text }) message per line for pipeline compatibility.
 *         Multi-line input "a\nb\nc" sends 3 separate messages.
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
import { print, println, eprintln, exit, getargs, send, respond } from '@os/process';

// Argument parsing
import { parseArgs } from '@os/args';

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
// ARGUMENT SPECS
// =============================================================================

/**
 * Argument specifications for parseArgs().
 *
 * GNU ECHO: Only -n and --help are recognized flags.
 * All other arguments (including unknown flags) become text.
 */
const ARG_SPECS = {
    noNewline: { short: 'n', desc: 'Do not output trailing newline' },
    help: { long: 'help', desc: 'Display help and exit' },
};

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

    // GNU ECHO: Only leading flags are parsed. Once a non-flag or unknown
    // flag is seen, all remaining args become text.
    const parsed = parseArgs(args.slice(1), ARG_SPECS, { stopAtFirstPositional: true });

    // -------------------------------------------------------------------------
    // Handle Help
    // -------------------------------------------------------------------------
    if (parsed.flags.help) {
        await println(HELP_TEXT);

        return exit(EXIT_SUCCESS);
    }

    // -------------------------------------------------------------------------
    // Format and Output
    // -------------------------------------------------------------------------
    try {
        const text = formatOutput(parsed.positional);

        // PROTOCOL: Send one message per line for proper pipeline composition.
        // Commands like sort, grep, uniq expect one line per message.
        const lines = text.split('\n');
        const noNewline = parsed.flags.noNewline === true;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const isLast = i === lines.length - 1;

            if (line === undefined) {
                continue;
            }

            // GNU BEHAVIOR: -n suppresses trailing newline on final line only
            if (isLast && noNewline) {
                await print(line);
            }
            else if (isLast) {
                await println(line);
            }
            else {
                // Not the last line - always include newline
                await println(line);
            }
        }

        // Signal end of stream for downstream commands
        await send(1, respond.done());

        return exit(EXIT_SUCCESS);
    }
    catch (err) {
        // EDGE: Write failure (disk full, broken pipe, etc.)
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`echo: write error: ${message}`);

        return exit(EXIT_FAILURE);
    }
}
