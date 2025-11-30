/**
 * which - locate a command
 *
 * Usage:
 *   which <command>...
 *
 * Shows the full path of shell commands.
 *
 * Examples:
 *   which ls
 *   which cat grep
 */

import { FSError } from '@src/lib/fs/index.js';
import type { CommandHandler } from './shared.js';

export const which: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('which: filesystem not available\n');
        return 1;
    }

    if (args.length === 0) {
        io.stderr.write('which: missing argument\n');
        return 1;
    }

    let exitCode = 0;

    for (const cmd of args) {
        const path = `/bin/${cmd}`;

        try {
            await fs.stat(path);
            io.stdout.write(path + '\n');
        } catch (err) {
            if (err instanceof FSError && err.code === 'ENOENT') {
                io.stderr.write(`${cmd}: not found\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    return exitCode;
};
