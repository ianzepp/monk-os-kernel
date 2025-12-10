/**
 * kill - Send signal to processes
 *
 * SYNOPSIS
 * ========
 * kill [-s SIGNAL | -SIGNAL] PID...
 * kill -l
 *
 * DESCRIPTION
 * ===========
 * Send a signal to processes specified by PID. By default, sends SIGTERM (15)
 * which requests graceful termination.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: POSIX.1-2017
 * Supported flags:
 *   -s SIGNAL     Specify signal by name (TERM, KILL, etc.)
 *   -SIGNAL       Specify signal by name (shorthand)
 *   -l            List signal names
 *   --help        Display help
 * Unsupported:
 *   -L            List signals in table format
 *
 * EXIT CODES
 * ==========
 * 0 - Success (at least one signal sent)
 * 1 - Failure (could not send signal)
 * 2 - Usage error
 *
 * SIGNALS
 * =======
 * Common signals:
 *   TERM (15) - Graceful termination (default)
 *   KILL (9)  - Forceful termination
 *   HUP (1)   - Hangup / reload config
 *   INT (2)   - Interrupt (Ctrl+C)
 *   QUIT (3)  - Quit with core dump
 *   USR1 (10) - User-defined signal 1
 *   USR2 (12) - User-defined signal 2
 *
 * @module rom/bin/kill
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { getargs, println, eprintln, exit, kill, send, respond } from '@rom/lib/process/index.js';
import { parseArgs, formatError } from '@rom/lib/args';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

/** Signal name to number mapping */
const SIGNALS: Record<string, number> = {
    HUP: 1,
    INT: 2,
    QUIT: 3,
    ILL: 4,
    TRAP: 5,
    ABRT: 6,
    BUS: 7,
    FPE: 8,
    KILL: 9,
    USR1: 10,
    SEGV: 11,
    USR2: 12,
    PIPE: 13,
    ALRM: 14,
    TERM: 15,
    CHLD: 17,
    CONT: 18,
    STOP: 19,
    TSTP: 20,
    TTIN: 21,
    TTOU: 22,
};

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: kill [-s SIGNAL | -SIGNAL] PID...
       kill -l

Send a signal to processes.

Options:
  -s SIGNAL   Specify signal by name or number
  -SIGNAL     Shorthand for -s SIGNAL (e.g., -TERM, -9)
  -l          List available signal names
  --help      Display this help and exit

Signals:
  TERM (15)   Graceful termination (default)
  KILL (9)    Forceful termination
  HUP (1)     Hangup / reload config
  INT (2)     Interrupt

Examples:
  kill 1234              Send SIGTERM to process 1234
  kill -9 1234           Send SIGKILL to process 1234
  kill -s KILL 1234      Same as above
  kill -TERM 1234 5678   Send SIGTERM to multiple processes
`.trim();

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const rawArgs = args.slice(1);

    // Handle -l (list signals)
    if (rawArgs.includes('-l')) {
        const names = Object.keys(SIGNALS).sort((a, b) => SIGNALS[a]! - SIGNALS[b]!);
        await println(names.join(' '));
        await send(1, respond.done());
        return exit(EXIT_SUCCESS);
    }

    // Handle --help
    if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
        await println(HELP_TEXT);
        await send(1, respond.done());
        return exit(EXIT_SUCCESS);
    }

    // Parse arguments manually to handle -SIGNAL shorthand
    let signal = 15; // Default: SIGTERM
    const pids: number[] = [];

    let i = 0;
    while (i < rawArgs.length) {
        const arg = rawArgs[i]!;

        if (arg === '-s' && i + 1 < rawArgs.length) {
            // -s SIGNAL
            const sigArg = rawArgs[++i]!;
            const parsed = parseSignal(sigArg);
            if (parsed === null) {
                await eprintln(`kill: invalid signal: ${sigArg}`);
                return exit(EXIT_USAGE);
            }
            signal = parsed;
        }
        else if (arg.startsWith('-') && arg.length > 1 && arg !== '--') {
            // -SIGNAL or -NUMBER
            const sigArg = arg.slice(1);
            const parsed = parseSignal(sigArg);
            if (parsed === null) {
                await eprintln(`kill: invalid signal: ${sigArg}`);
                return exit(EXIT_USAGE);
            }
            signal = parsed;
        }
        else if (arg === '--') {
            // End of options, rest are PIDs
            for (let j = i + 1; j < rawArgs.length; j++) {
                const pid = parseInt(rawArgs[j]!, 10);
                if (isNaN(pid) || pid <= 0) {
                    await eprintln(`kill: invalid pid: ${rawArgs[j]}`);
                    return exit(EXIT_USAGE);
                }
                pids.push(pid);
            }
            break;
        }
        else {
            // PID
            const pid = parseInt(arg, 10);
            if (isNaN(pid) || pid <= 0) {
                await eprintln(`kill: invalid pid: ${arg}`);
                return exit(EXIT_USAGE);
            }
            pids.push(pid);
        }
        i++;
    }

    if (pids.length === 0) {
        await eprintln('kill: missing pid');
        await eprintln('Try \'kill --help\' for more information.');
        return exit(EXIT_USAGE);
    }

    // Send signal to each PID
    let hadError = false;
    for (const pid of pids) {
        try {
            await kill(pid, signal);
        }
        catch (err) {
            await eprintln(`kill: (${pid}): ${formatError(err)}`);
            hadError = true;
        }
    }

    await send(1, respond.done());
    return exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}

/**
 * Parse signal argument (name or number).
 */
function parseSignal(arg: string): number | null {
    // Try as number
    const num = parseInt(arg, 10);
    if (!isNaN(num) && num > 0 && num < 32) {
        return num;
    }

    // Try as name (with or without SIG prefix)
    const name = arg.toUpperCase().replace(/^SIG/, '');
    if (name in SIGNALS) {
        return SIGNALS[name]!;
    }

    return null;
}
