/**
 * rmdir - Remove directory
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const rmdir: CommandHandler = async (session, fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('rmdir: missing operand\n');
        return 1;
    }

    let exitCode = 0;
    for (const dir of args) {
        if (dir.startsWith('-')) continue;
        const resolved = resolvePath(session.cwd, dir);

        try {
            await fs!.rmdir(resolved);
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`rmdir: ${dir}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }
    return exitCode;
};
