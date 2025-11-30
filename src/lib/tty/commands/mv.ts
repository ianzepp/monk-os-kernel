/**
 * mv - Move/rename file or directory
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const mv: CommandHandler = async (session, fs, args, io) => {
    const files = args.filter(a => !a.startsWith('-'));

    if (files.length < 2) {
        io.stderr.write('mv: missing destination\n');
        return 1;
    }

    const dest = resolvePath(session.cwd, files.pop()!);
    const sources = files.map(f => resolvePath(session.cwd, f));

    let exitCode = 0;
    for (const src of sources) {
        try {
            await fs!.rename(src, dest);
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`mv: ${src}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }
    return exitCode;
};
