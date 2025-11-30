/**
 * time - Time command execution
 *
 * Usage:
 *   time [options] <command> [args...]
 *
 * Options:
 *   -p              POSIX format output
 *   -v              Verbose output
 *
 * Output:
 *   real    Wall clock time
 *   user    User CPU time (simulated)
 *   sys     System CPU time (simulated)
 *
 * Examples:
 *   time find /api/data
 *   time -p sleep 2
 *   time cat /api/data/users/* | wc -l
 */

import { PassThrough } from 'node:stream';
import type { FS } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';
import type { Session, CommandIO } from '../types.js';

// Command registry injected from index.ts
let commandRegistry: Record<string, CommandHandler> | null = null;

export function setTimeCommandRegistry(registry: Record<string, CommandHandler>): void {
    commandRegistry = registry;
}

type TimeOptions = {
    posix: boolean;
    verbose: boolean;
};

/**
 * Format duration in seconds with 3 decimal places
 */
function formatSeconds(ms: number): string {
    return (ms / 1000).toFixed(3);
}

/**
 * Format duration as mm:ss.sss
 */
function formatMinSec(ms: number): string {
    const totalSec = ms / 1000;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}m${sec.toFixed(3)}s`;
}

export const time: CommandHandler = async (session: Session, fs: FS | null, args: string[], io: CommandIO) => {
    // Parse options manually (simple flags only)
    let posix = false;
    let verbose = false;
    let cmdStart = 0;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-p') {
            posix = true;
            cmdStart = i + 1;
        } else if (args[i] === '-v') {
            verbose = true;
            cmdStart = i + 1;
        } else if (args[i].startsWith('-')) {
            // Unknown flag, stop parsing
            break;
        } else {
            cmdStart = i;
            break;
        }
    }

    const cmdArgs = args.slice(cmdStart);

    if (cmdArgs.length === 0) {
        io.stderr.write('time: missing command\n');
        io.stderr.write('Usage: time [options] <command> [args...]\n');
        return 1;
    }

    if (!commandRegistry) {
        io.stderr.write('time: command registry not initialized\n');
        return 1;
    }

    const commandName = cmdArgs[0];
    const commandArgs = cmdArgs.slice(1);

    const handler = commandRegistry[commandName];
    if (!handler) {
        io.stderr.write(`time: ${commandName}: command not found\n`);
        return 127;
    }

    // Create IO for child command
    const childIO: CommandIO = {
        stdin: io.stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signal: io.signal,
    };

    childIO.stdout.pipe(io.stdout, { end: false });
    childIO.stderr.pipe(io.stderr, { end: false });

    // Time the execution
    const startTime = performance.now();
    let exitCode: number;

    try {
        exitCode = await handler(session, fs, commandArgs, childIO);
    } catch (err) {
        exitCode = 1;
    }

    const endTime = performance.now();
    const realTime = endTime - startTime;

    // Simulate user/sys time (we don't have real CPU stats)
    // In a real system these would come from process.cpuUsage()
    const userTime = realTime * 0.7; // Simulated: 70% user
    const sysTime = realTime * 0.1;  // Simulated: 10% system

    // Output timing
    io.stderr.write('\n');

    if (posix) {
        // POSIX format
        io.stderr.write(`real ${formatSeconds(realTime)}\n`);
        io.stderr.write(`user ${formatSeconds(userTime)}\n`);
        io.stderr.write(`sys ${formatSeconds(sysTime)}\n`);
    } else if (verbose) {
        // Verbose format
        io.stderr.write(`Command: ${cmdArgs.join(' ')}\n`);
        io.stderr.write(`Exit status: ${exitCode}\n`);
        io.stderr.write(`Real time: ${formatMinSec(realTime)}\n`);
        io.stderr.write(`User time: ${formatMinSec(userTime)}\n`);
        io.stderr.write(`System time: ${formatMinSec(sysTime)}\n`);
    } else {
        // Default bash-like format
        io.stderr.write(`real\t${formatMinSec(realTime)}\n`);
        io.stderr.write(`user\t${formatMinSec(userTime)}\n`);
        io.stderr.write(`sys\t${formatMinSec(sysTime)}\n`);
    }

    return exitCode;
};
