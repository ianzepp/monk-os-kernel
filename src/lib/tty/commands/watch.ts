/**
 * watch - Execute a command periodically
 *
 * Usage:
 *   watch [options] <command>
 *
 * Options:
 *   -n <seconds>    Interval between executions (default 2)
 *   -d              Highlight differences
 *   -t              No title header
 *   -e              Exit on error (non-zero exit code)
 *   -g              Exit when output changes
 *   -c              Interpret ANSI color sequences
 *
 * Examples:
 *   watch ps                    Monitor processes every 2s
 *   watch -n 5 ls -l            List files every 5 seconds
 *   watch -d cat /proc/1/status Monitor process, highlight changes
 *   watch -e ping /health       Stop on ping failure
 *   watch -n 1 date             Show time updating every second
 *
 * Exit:
 *   Press Ctrl+C to stop watching
 */

import { PassThrough } from 'node:stream';
import type { FS } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';
import type { Session, CommandIO } from '../types.js';

// Command registry injected from index.ts
let commandRegistry: Record<string, CommandHandler> | null = null;

export function setWatchCommandRegistry(registry: Record<string, CommandHandler>): void {
    commandRegistry = registry;
}

const argSpecs = {
    interval: { short: 'n', value: true, desc: 'Interval seconds' },
    differences: { short: 'd', desc: 'Highlight differences' },
    noTitle: { short: 't', desc: 'No title' },
    exitOnError: { short: 'e', desc: 'Exit on error' },
    exitOnChange: { short: 'g', desc: 'Exit on change' },
    color: { short: 'c', desc: 'ANSI colors' },
};

type WatchOptions = {
    interval: number;
    differences: boolean;
    noTitle: boolean;
    exitOnError: boolean;
    exitOnChange: boolean;
    color: boolean;
};

/**
 * Clear screen escape sequence
 */
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

/**
 * Highlight differences between old and new output
 */
function highlightDifferences(oldLines: string[], newLines: string[]): string[] {
    const result: string[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLen; i++) {
        const oldLine = oldLines[i] || '';
        const newLine = newLines[i] || '';

        if (oldLine !== newLine) {
            // Highlight changed line
            result.push(`\x1b[7m${newLine}\x1b[0m`); // Inverse video
        } else {
            result.push(newLine);
        }
    }

    return result;
}

/**
 * Capture command output
 */
async function captureOutput(
    session: Session,
    fs: FS | null,
    handler: CommandHandler,
    cmdArgs: string[],
    signal: AbortSignal | undefined
): Promise<{ output: string; exitCode: number }> {
    let output = '';

    const childIO: CommandIO = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signal,
    };

    childIO.stdin.end();

    childIO.stdout.on('data', (chunk) => {
        output += chunk.toString();
    });

    childIO.stderr.on('data', (chunk) => {
        output += chunk.toString();
    });

    let exitCode: number;
    try {
        exitCode = await handler(session, fs, cmdArgs, childIO);
    } catch {
        exitCode = 1;
    }

    return { output, exitCode };
}

export const watch: CommandHandler = async (session: Session, fs: FS | null, args: string[], io: CommandIO) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`watch: ${err}\n`);
        }
        return 1;
    }

    if (parsed.positional.length === 0) {
        io.stderr.write('watch: missing command\n');
        io.stderr.write('Usage: watch [options] <command>\n');
        return 1;
    }

    const options: WatchOptions = {
        interval: typeof parsed.flags.interval === 'string'
            ? parseFloat(parsed.flags.interval)
            : 2,
        differences: Boolean(parsed.flags.differences),
        noTitle: Boolean(parsed.flags.noTitle),
        exitOnError: Boolean(parsed.flags.exitOnError),
        exitOnChange: Boolean(parsed.flags.exitOnChange),
        color: Boolean(parsed.flags.color),
    };

    if (isNaN(options.interval) || options.interval <= 0) {
        io.stderr.write('watch: invalid interval\n');
        return 1;
    }

    if (!commandRegistry) {
        io.stderr.write('watch: command registry not initialized\n');
        return 1;
    }

    const commandName = parsed.positional[0];
    const commandArgs = parsed.positional.slice(1);

    const handler = commandRegistry[commandName];
    if (!handler) {
        io.stderr.write(`watch: ${commandName}: command not found\n`);
        return 127;
    }

    const cmdString = parsed.positional.join(' ');
    let previousOutput = '';
    let iteration = 0;

    while (true) {
        // Check for abort signal
        if (io.signal?.aborted) {
            return 130;
        }

        // Clear screen
        io.stdout.write(CLEAR_SCREEN);

        // Print header
        if (!options.noTitle) {
            const now = new Date().toLocaleString();
            io.stdout.write(`Every ${options.interval}s: ${cmdString}`);
            io.stdout.write(`\t\t${now}\n\n`);
        }

        // Execute command
        const { output, exitCode } = await captureOutput(
            session, fs, handler, commandArgs, io.signal
        );

        // Check for abort after execution
        if (io.signal?.aborted) {
            return 130;
        }

        // Exit on error
        if (options.exitOnError && exitCode !== 0) {
            io.stdout.write(output);
            io.stderr.write(`\nwatch: command exit with ${exitCode}\n`);
            return exitCode;
        }

        // Exit on change
        if (options.exitOnChange && iteration > 0 && output !== previousOutput) {
            io.stdout.write(output);
            return 0;
        }

        // Output with optional difference highlighting
        if (options.differences && iteration > 0) {
            const oldLines = previousOutput.split('\n');
            const newLines = output.split('\n');
            const highlighted = highlightDifferences(oldLines, newLines);
            io.stdout.write(highlighted.join('\n'));
        } else {
            io.stdout.write(output);
        }

        previousOutput = output;
        iteration++;

        // Wait for interval
        const intervalMs = options.interval * 1000;
        const startWait = Date.now();

        while (Date.now() - startWait < intervalMs) {
            if (io.signal?.aborted) {
                return 130;
            }
            // Check every 100ms for abort
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
};
