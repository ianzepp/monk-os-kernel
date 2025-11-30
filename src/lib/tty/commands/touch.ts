/**
 * touch - Create empty file
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const touch: CommandHandler = async (session, fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('touch: missing operand\n');
        return 1;
    }

    let exitCode = 0;
    for (const arg of args) {
        const resolved = resolvePath(session.cwd, arg);

        try {
            const exists = await fs!.exists(resolved);
            if (!exists) {
                await fs!.write(resolved, '');
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`touch: ${arg}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }
    return exitCode;
};
