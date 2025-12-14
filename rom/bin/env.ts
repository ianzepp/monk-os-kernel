/**
 * env - Display environment variables
 *
 * SYNOPSIS
 * ========
 * env [OPTIONS]
 *
 * DESCRIPTION
 * ===========
 * Print the current environment variables to standard output, one per line,
 * in the format NAME=VALUE.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU coreutils env (display mode only)
 * Supported flags:
 *   --help        Display help text and exit
 * Unsupported flags:
 *   -i            Start with empty environment
 *   -u NAME       Remove variable from environment
 *   NAME=VALUE    Set variable before running command
 *   COMMAND       Run command with modified environment
 *
 * EXIT CODES
 * ==========
 * 0 - Success
 * 1 - General error
 *
 * @module rom/bin/env
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { println, exit, getargs, getenv, send, respond } from '@rom/lib/process/index.js';
import { parseArgs } from '@rom/lib/args';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SUCCESS = 0;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: env [OPTIONS]

Display environment variables.

Options:
  --help      Display this help and exit

Examples:
  env                     Show all environment variables
  env | grep PATH         Filter for PATH-related variables
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    help: { long: 'help', desc: 'Display help and exit' },
};

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    if (parsed.flags.help) {
        await println(HELP_TEXT);

        return exit(EXIT_SUCCESS);
    }

    // Get environment from Monk OS process
    const env = await getenv();

    for (const [key, value] of Object.entries(env)) {
        await println(`${key}=${value}`);
    }

    await send(1, respond.done());

    return exit(EXIT_SUCCESS);
}
