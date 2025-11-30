/**
 * cat - Display file contents or pass through stdin
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const cat: CommandHandler = async (session, fs, args, io) => {
    // If no args, pass through stdin (for piping)
    if (args.length === 0 || args.every(a => a.startsWith('-'))) {
        for await (const chunk of io.stdin) {
            io.stdout.write(chunk);
        }
        return 0;
    }

    if (!fs) {
        io.stderr.write('cat: filesystem not available\n');
        return 1;
    }

    let exitCode = 0;
    for (const arg of args) {
        if (arg.startsWith('-')) continue;
        const resolved = resolvePath(session.cwd, arg);

        try {
            const content = await fs.read(resolved);
            io.stdout.write(content.toString());
            if (!content.toString().endsWith('\n')) {
                io.stdout.write('\n');
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`cat: ${arg}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }
    return exitCode;
};
