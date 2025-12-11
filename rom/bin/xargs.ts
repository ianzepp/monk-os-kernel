/**
 * xargs - Build and execute commands from stdin
 *
 * SYNOPSIS
 * ========
 * xargs [OPTIONS] [COMMAND [INITIAL-ARGS]]
 *
 * DESCRIPTION
 * ===========
 * Read items from stdin and execute COMMAND with those items as arguments.
 * By default, items are delimited by whitespace (spaces, tabs, newlines).
 * If no command is specified, defaults to 'echo'.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: POSIX.1-2017 + GNU extensions
 * Supported flags:
 *   -0, --null           Items are null-delimited instead of whitespace
 *   -I REPLACE           Replace REPLACE in command with input item (implies -n 1)
 *   -n MAX               Use at most MAX arguments per command
 *   -t, --verbose        Print commands before executing
 *   --help               Display help
 * Unsupported:
 *   -P MAX               Run up to MAX processes in parallel
 *   -L MAX               Use at most MAX non-blank input lines
 *   -d DELIM             Custom delimiter
 *   -s SIZE              Limit command line to SIZE characters
 *   -x                   Exit if size exceeded
 *
 * EXIT CODES
 * ==========
 * 0   - Success
 * 123 - Command invocation error (1-125)
 * 124 - Command killed by signal
 * 125 - xargs itself failed
 * 126 - Command cannot be run
 * 127 - Command not found
 *
 * EXAMPLES
 * ========
 * echo "a b c" | xargs echo           # echo a b c
 * find . -name "*.ts" | xargs wc -l   # Count lines in all .ts files
 * echo -e "a\nb\nc" | xargs -I {} echo "item: {}"
 *
 * @module rom/bin/xargs
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    getargs, recv, println, eprintln, exit, spawn, wait, send, respond,
} from '@rom/lib/process/index.js';
import { parseArgs, formatError } from '@rom/lib/args';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_COMMAND_ERROR = 123;
const EXIT_KILLED = 124;
const EXIT_FAILURE = 125;
const EXIT_NOT_EXECUTABLE = 126;
const EXIT_NOT_FOUND = 127;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: xargs [OPTIONS] [COMMAND [INITIAL-ARGS]]

Build and execute commands from stdin.

Options:
  -0, --null      Items are null-delimited instead of whitespace
  -I REPLACE      Replace REPLACE in command with input item (implies -n 1)
  -n MAX          Use at most MAX arguments per command line
  -t, --verbose   Print commands before executing
  --help          Display this help and exit

Exit codes:
  0    Success
  123  Command invocation error
  124  Command killed by signal
  125  xargs itself failed
  126  Command cannot be run
  127  Command not found

Examples:
  echo "a b c" | xargs echo
  find . -name "*.ts" | xargs wc -l
  echo -e "a\\nb\\nc" | xargs -I {} echo "item: {}"
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    null: { short: '0', long: 'null', desc: 'Null-delimited input' },
    replace: { short: 'I', value: true, desc: 'Replace string' },
    maxArgs: { short: 'n', value: true, desc: 'Max arguments per command' },
    verbose: { short: 't', long: 'verbose', desc: 'Print commands' },
    help: { long: 'help', desc: 'Display help' },
};

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    if (parsed.flags.help) {
        await println(HELP_TEXT);
        await send(1, respond.done());

        return exit(EXIT_SUCCESS);
    }

    // Parse options
    const nullDelimited = !!parsed.flags.null;
    const replaceStr = parsed.flags.replace ? String(parsed.flags.replace) : null;
    const maxArgsPerCommand = parsed.flags.maxArgs
        ? parseInt(String(parsed.flags.maxArgs), 10)
        : (replaceStr ? 1 : Infinity);
    const verbose = !!parsed.flags.verbose;

    if (parsed.flags.maxArgs && isNaN(maxArgsPerCommand)) {
        await eprintln(`xargs: invalid number: ${parsed.flags.maxArgs}`);

        return exit(EXIT_FAILURE);
    }

    // Get command and initial args
    const command = parsed.positional[0] ?? 'echo';
    const initialArgs = parsed.positional.slice(1);

    // Collect items from stdin
    const items = await collectItems(nullDelimited);

    if (items.length === 0) {
        // No input: don't run command (GNU xargs behavior)
        await send(1, respond.done());

        return exit(EXIT_SUCCESS);
    }

    // Execute commands with items
    let hadError = false;
    let exitCode = EXIT_SUCCESS;

    if (replaceStr) {
        // Replace mode: one item per command invocation
        for (const item of items) {
            const cmdArgs = initialArgs.map(arg =>
                arg === replaceStr ? item : arg,
            );

            const code = await executeCommand(command, cmdArgs, verbose);

            if (code !== 0) {
                hadError = true;
                exitCode = mapExitCode(code);
            }
        }
    }
    else {
        // Batch mode: group items into chunks
        for (let i = 0; i < items.length; i += maxArgsPerCommand) {
            const chunk = items.slice(i, i + maxArgsPerCommand);
            const cmdArgs = [...initialArgs, ...chunk];

            const code = await executeCommand(command, cmdArgs, verbose);

            if (code !== 0) {
                hadError = true;
                exitCode = mapExitCode(code);
            }
        }
    }

    await send(1, respond.done());

    return exit(hadError ? exitCode : EXIT_SUCCESS);
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Collect items from stdin.
 */
async function collectItems(nullDelimited: boolean): Promise<string[]> {
    const items: string[] = [];
    let buffer = '';

    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const text = (msg.data as { text?: string }).text ?? '';

            buffer += text;
        }
    }

    if (nullDelimited) {
        // Split by null bytes
        const parts = buffer.split('\0');

        // Remove trailing empty string if buffer ended with null
        if (parts[parts.length - 1] === '') {
            parts.pop();
        }

        items.push(...parts.filter(s => s.length > 0));
    }
    else {
        // Split by whitespace (spaces, tabs, newlines)
        const parts = buffer.split(/\s+/);

        items.push(...parts.filter(s => s.length > 0));
    }

    return items;
}

/**
 * Execute a command with arguments.
 * Returns exit code.
 */
async function executeCommand(
    command: string,
    cmdArgs: string[],
    verbose: boolean,
): Promise<number> {
    if (verbose) {
        await eprintln([command, ...cmdArgs].join(' '));
    }

    // Spawn the command
    let pid: number;

    try {
        pid = await spawn(`/bin/${command}.ts`, {
            args: [command, ...cmdArgs],
        });
    }
    catch (err) {
        const msg = formatError(err);

        if (msg.includes('not found') || msg.includes('ENOENT')) {
            await eprintln(`xargs: ${command}: command not found`);

            return EXIT_NOT_FOUND;
        }

        await eprintln(`xargs: ${command}: ${msg}`);

        return EXIT_NOT_EXECUTABLE;
    }

    // Wait for command to complete
    try {
        const status = await wait(pid);

        return status.code;
    }
    catch (err) {
        await eprintln(`xargs: ${command}: ${formatError(err)}`);

        return EXIT_FAILURE;
    }
}

/**
 * Map command exit code to xargs exit code.
 */
function mapExitCode(code: number): number {
    if (code === 0) {
        return EXIT_SUCCESS;
    }

    if (code > 128) {
        return EXIT_KILLED; // Killed by signal
    }

    if (code >= 1 && code <= 125) {
        return EXIT_COMMAND_ERROR;
    }

    if (code === 126) {
        return EXIT_NOT_EXECUTABLE;
    }

    if (code === 127) {
        return EXIT_NOT_FOUND;
    }

    return EXIT_COMMAND_ERROR;
}
