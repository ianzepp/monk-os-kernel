/**
 * timeout - Run a command with a time limit
 *
 * SYNOPSIS
 * ========
 * timeout [OPTIONS] DURATION COMMAND [ARGS...]
 *
 * DESCRIPTION
 * ===========
 * Run COMMAND and kill it if it doesn't finish within DURATION. By default,
 * sends SIGTERM on timeout, then SIGKILL after a grace period.
 *
 * DURATION is a number with optional suffix:
 *   s - seconds (default)
 *   m - minutes
 *   h - hours
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU coreutils timeout
 * Supported flags:
 *   -s, --signal=SIGNAL   Signal to send on timeout (default: TERM)
 *   -k, --kill-after=DUR  Send SIGKILL after DUR if still running
 *   --preserve-status     Exit with command's status even on timeout
 *   --help                Display help
 * Unsupported:
 *   --foreground          Don't create new process group
 *   -v, --verbose         Diagnose to stderr
 *
 * EXIT CODES
 * ==========
 * If command completes:
 *   Returns command's exit code
 * If timeout occurs:
 *   124 - Command timed out
 *   137 - Command killed with SIGKILL (128 + 9)
 * Other:
 *   125 - timeout itself failed
 *   126 - Command found but not executable
 *   127 - Command not found
 *
 * @module rom/bin/timeout
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    getargs, println, eprintln, exit, spawn, wait, kill, sleep, send, respond,
} from '@rom/lib/process/index.js';
import { parseArgs, parseDuration, formatError } from '@rom/lib/args';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_TIMEOUT = 124;
const EXIT_KILLED = 137; // 128 + SIGKILL(9)
const EXIT_FAILURE = 125;
const EXIT_NOT_EXECUTABLE = 126;
const EXIT_NOT_FOUND = 127;

/** Signal name to number mapping */
const SIGNALS: Record<string, number> = {
    HUP: 1,
    INT: 2,
    QUIT: 3,
    KILL: 9,
    USR1: 10,
    USR2: 12,
    TERM: 15,
};

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: timeout [OPTIONS] DURATION COMMAND [ARGS...]

Run a command with a time limit.

Options:
  -s, --signal=SIGNAL     Signal to send on timeout (default: TERM)
  -k, --kill-after=DUR    Send SIGKILL if still running after DUR
  --preserve-status       Exit with command's status even on timeout
  --help                  Display this help and exit

Duration format:
  NUMBER[SUFFIX]
  Suffixes: s (seconds), m (minutes), h (hours)
  Default suffix is seconds.

Exit codes:
  124  Command timed out
  125  timeout itself failed
  126  Command not executable
  127  Command not found
  Other: command's exit code

Examples:
  timeout 5 sleep 10          Kill sleep after 5 seconds
  timeout 30s make build      30 second timeout
  timeout -k 5 30 command     SIGTERM at 30s, SIGKILL at 35s
  timeout -s KILL 10 command  Send SIGKILL instead of SIGTERM
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    signal: { short: 's', long: 'signal', value: true, desc: 'Signal to send' },
    killAfter: { short: 'k', long: 'kill-after', value: true, desc: 'Kill after duration' },
    preserveStatus: { long: 'preserve-status', desc: 'Preserve command exit status' },
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
        return exit(0);
    }

    // Need at least duration and command
    if (parsed.positional.length < 2) {
        await eprintln('timeout: missing operand');
        await eprintln('Try \'timeout --help\' for more information.');
        return exit(EXIT_FAILURE);
    }

    // Parse duration
    const durationArg = parsed.positional[0]!;
    const durationMs = parseDuration(durationArg);
    if (durationMs === null || durationMs < 0) {
        await eprintln(`timeout: invalid duration: ${durationArg}`);
        return exit(EXIT_FAILURE);
    }

    // Parse kill-after duration
    let killAfterMs: number | null = null;
    if (parsed.flags.killAfter) {
        killAfterMs = parseDuration(String(parsed.flags.killAfter));
        if (killAfterMs === null || killAfterMs < 0) {
            await eprintln(`timeout: invalid kill-after duration: ${parsed.flags.killAfter}`);
            return exit(EXIT_FAILURE);
        }
    }

    // Parse signal
    let signal = 15; // SIGTERM
    if (parsed.flags.signal) {
        const sigArg = String(parsed.flags.signal).toUpperCase().replace(/^SIG/, '');
        const sigNum = parseInt(sigArg, 10);
        if (!isNaN(sigNum) && sigNum > 0 && sigNum < 32) {
            signal = sigNum;
        }
        else if (sigArg in SIGNALS) {
            signal = SIGNALS[sigArg]!;
        }
        else {
            await eprintln(`timeout: invalid signal: ${parsed.flags.signal}`);
            return exit(EXIT_FAILURE);
        }
    }

    const preserveStatus = !!parsed.flags.preserveStatus;

    // Get command and arguments
    const command = parsed.positional[1]!;
    const cmdArgs = parsed.positional.slice(2);

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
            await eprintln(`timeout: ${command}: command not found`);
            return exit(EXIT_NOT_FOUND);
        }
        await eprintln(`timeout: ${command}: ${msg}`);
        return exit(EXIT_NOT_EXECUTABLE);
    }

    // Race: wait for process vs timeout
    let timedOut = false;
    let killed = false;

    // Create timeout promise
    const timeoutPromise = (async () => {
        await sleep(durationMs);
        timedOut = true;

        // Send initial signal
        try {
            await kill(pid, signal);
        }
        catch {
            // Process may have already exited
            return;
        }

        // If kill-after specified, wait then send SIGKILL
        if (killAfterMs !== null) {
            await sleep(killAfterMs);
            try {
                await kill(pid, 9); // SIGKILL
                killed = true;
            }
            catch {
                // Process exited
            }
        }
    })();

    // Wait for process to exit
    const waitPromise = wait(pid);

    // Race between wait and timeout
    const status = await Promise.race([
        waitPromise,
        timeoutPromise.then(() => waitPromise), // After timeout, still wait for exit
    ]);

    // Determine exit code
    if (timedOut) {
        if (preserveStatus) {
            return exit(status.code);
        }
        return exit(killed ? EXIT_KILLED : EXIT_TIMEOUT);
    }

    // Command completed normally
    await send(1, respond.done());
    return exit(status.code);
}
