/**
 * count - Count records in a collection
 *
 * Usage:
 *   count [path]
 *
 * Examples:
 *   count                            Count in current directory
 *   count /api/data/users            Count users
 *   count users                      Count users (relative)
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const count: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('count: filesystem not available\n');
        return 1;
    }

    const pathArg = args[0] || '.';
    const resolved = resolvePath(session.cwd, pathArg);

    try {
        const stat = await fs.stat(resolved);

        if (stat.type !== 'directory') {
            io.stderr.write(`count: ${pathArg}: not a directory\n`);
            return 1;
        }

        const entries = await fs.readdir(resolved);
        const fileCount = entries.filter(e => e.type === 'file').length;

        io.stdout.write(String(fileCount) + '\n');
        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`count: ${pathArg}: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
};
