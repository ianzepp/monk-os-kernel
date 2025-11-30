/**
 * mkdir - Create directory
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const mkdir: CommandHandler = async (session, fs, args, io) => {
    const parents = args.includes('-p');
    const dirs = args.filter(a => !a.startsWith('-'));

    if (dirs.length === 0) {
        io.stderr.write('mkdir: missing operand\n');
        return 1;
    }

    let exitCode = 0;
    for (const dir of dirs) {
        const resolved = resolvePath(session.cwd, dir);

        try {
            if (parents) {
                // Create parent directories as needed
                const parts = resolved.split('/').filter(Boolean);
                let current = '';
                for (const part of parts) {
                    current += '/' + part;
                    const exists = await fs!.exists(current);
                    if (!exists) {
                        await fs!.mkdir(current);
                    }
                }
            } else {
                await fs!.mkdir(resolved);
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`mkdir: ${dir}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }
    return exitCode;
};
