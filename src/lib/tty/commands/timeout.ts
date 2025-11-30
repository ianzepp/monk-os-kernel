/**
 * timeout - Run command with a time limit
 */

import type { CommandHandler } from './shared.js';
import { parseDuration } from './shared.js';
import type { Session, CommandIO } from '../types.js';
import type { FS } from '@src/lib/fs/index.js';
import { PassThrough } from 'node:stream';

// We need access to the command registry, but can't import it directly
// due to circular deps. The caller will inject it.
let commandRegistry: Record<string, CommandHandler> | null = null;

export function setCommandRegistry(registry: Record<string, CommandHandler>): void {
    commandRegistry = registry;
}

export const timeout: CommandHandler = async (session: Session, fs: FS | null, args: string[], io: CommandIO) => {
    if (args.length < 2) {
        io.stderr.write('timeout: missing operand\n');
        io.stderr.write('Usage: timeout DURATION COMMAND [ARGS...]\n');
        return 1;
    }

    const duration = parseDuration(args[0]);
    if (duration === null) {
        io.stderr.write(`timeout: invalid time interval '${args[0]}'\n`);
        return 1;
    }

    const commandName = args[1];
    const commandArgs = args.slice(2);

    if (!commandRegistry) {
        io.stderr.write('timeout: command registry not initialized\n');
        return 1;
    }

    const handler = commandRegistry[commandName];
    if (!handler) {
        io.stderr.write(`timeout: ${commandName}: command not found\n`);
        return 127;
    }

    // Create abort controller for timeout
    const abortController = new AbortController();

    // Create a new IO that pipes through to the original
    const childIO: CommandIO = {
        stdin: io.stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signal: abortController.signal,
    };

    childIO.stdout.pipe(io.stdout, { end: false });
    childIO.stderr.pipe(io.stderr, { end: false });

    // Race the command against the timeout
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort();
    }, duration);

    try {
        const exitCode = await handler(session, fs, commandArgs, childIO);
        clearTimeout(timeoutId);
        return exitCode;
    } catch {
        clearTimeout(timeoutId);
        if (timedOut) {
            io.stderr.write(`timeout: ${commandName}: timed out after ${args[0]}\n`);
            return 124; // Standard timeout exit code
        }
        throw new Error(`timeout: ${commandName}: unexpected error`);
    }
};
