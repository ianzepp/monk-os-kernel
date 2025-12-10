/**
 * ps - Report process status
 *
 * SYNOPSIS
 * ========
 * ps [OPTIONS]
 *
 * DESCRIPTION
 * ===========
 * Display information about running processes. By default, shows all processes
 * in the system with PID, PPID, state, user, and command.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: Simplified POSIX ps
 * Supported flags:
 *   -e, -A        Select all processes (default behavior)
 *   --help        Display help
 * Unsupported:
 *   -f            Full format (partial - always shows full format)
 *   -l            Long format
 *   -u USER       Select by user
 *   -p PID        Select by PID
 *
 * EXIT CODES
 * ==========
 * 0 - Success
 * 1 - Failure
 *
 * OUTPUT FORMAT
 * =============
 * PID   PPID  STATE    USER     CMD
 * 1     0     running  root     /bin/init
 * 2     1     running  root     /bin/shell
 *
 * @module rom/bin/ps
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { getargs, println, eprintln, exit, listProcesses, send, respond } from '@rom/lib/process/index.js';
import type { ProcessInfo } from '@rom/lib/process/index.js';
import { parseArgs, formatError } from '@rom/lib/args';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: ps [OPTIONS]

Report process status.

Options:
  -e, -A      Select all processes (default)
  --help      Display this help and exit

Output columns:
  PID         Process ID
  PPID        Parent process ID
  STATE       Process state (running, stopped, zombie)
  USER        User identity
  CMD         Command/entry point

Examples:
  ps              Show all processes
  ps | grep shell Find shell processes
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    all: { short: 'e', long: 'all', desc: 'Select all processes' },
    All: { short: 'A', desc: 'Select all processes' },
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

    try {
        const processes = await listProcesses();

        // Print header
        await println(formatHeader());

        // Sort by PID for consistent output
        processes.sort((a, b) => a.pid - b.pid);

        // Print each process
        for (const proc of processes) {
            await println(formatProcess(proc));
        }

        await send(1, respond.done());
        return exit(EXIT_SUCCESS);
    }
    catch (err) {
        await eprintln(`ps: ${formatError(err)}`);
        return exit(EXIT_FAILURE);
    }
}

/**
 * Format the header line.
 */
function formatHeader(): string {
    return [
        'PID'.padStart(5),
        'PPID'.padStart(5),
        'STATE'.padEnd(8),
        'USER'.padEnd(10),
        'CMD',
    ].join('  ');
}

/**
 * Format a process line.
 */
function formatProcess(proc: ProcessInfo): string {
    return [
        String(proc.pid).padStart(5),
        String(proc.ppid).padStart(5),
        proc.state.padEnd(8),
        proc.user.slice(0, 10).padEnd(10),
        proc.cmd,
    ].join('  ');
}
