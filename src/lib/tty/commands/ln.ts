/**
 * ln - Create links
 *
 * Usage:
 *   ln -s <target> <link>    Create symbolic link
 *   ln -sf <target> <link>   Force overwrite existing link
 *
 * Options:
 *   -s    Create symbolic link (required)
 *   -f    Force - remove existing destination
 *
 * Examples:
 *   ln -s /api/data/users /home/root/users
 *   ln -sf ../config.json /tmp/config
 *
 * Note: Hard links are not supported. Use -s for symbolic links.
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const ln: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('ln: filesystem not available\n');
        return 1;
    }

    // Parse options
    let symbolic = false;
    let force = false;
    const positional: string[] = [];

    for (const arg of args) {
        if (arg === '-s' || arg === '--symbolic') {
            symbolic = true;
        } else if (arg === '-f' || arg === '--force') {
            force = true;
        } else if (arg === '-sf' || arg === '-fs') {
            symbolic = true;
            force = true;
        } else if (arg.startsWith('-')) {
            // Parse combined flags like -sf
            const flags = arg.slice(1);
            for (const flag of flags) {
                if (flag === 's') symbolic = true;
                else if (flag === 'f') force = true;
                else {
                    io.stderr.write(`ln: invalid option -- '${flag}'\n`);
                    return 1;
                }
            }
        } else {
            positional.push(arg);
        }
    }

    // Require symbolic flag (hard links not supported)
    if (!symbolic) {
        io.stderr.write('ln: hard links not supported, use -s for symbolic links\n');
        return 1;
    }

    if (positional.length < 2) {
        io.stderr.write('ln: missing file operand\n');
        io.stderr.write('Usage: ln -s <target> <link>\n');
        return 1;
    }

    const targetArg = positional[0];
    const linkArg = positional[1];

    // Target is stored as-is (can be relative or absolute)
    // Link path is resolved to absolute
    const linkPath = resolvePath(session.cwd, linkArg);

    try {
        // Check if link already exists
        if (force) {
            try {
                const stat = await fs.stat(linkPath);
                if (stat.type === 'symlink') {
                    await fs.unlink(linkPath);
                } else if (stat.type === 'file') {
                    await fs.unlink(linkPath);
                } else {
                    io.stderr.write(`ln: cannot overwrite directory '${linkArg}'\n`);
                    return 1;
                }
            } catch (err) {
                // Doesn't exist, that's fine
                if (!(err instanceof FSError && err.code === 'ENOENT')) {
                    throw err;
                }
            }
        }

        await fs.symlink(targetArg, linkPath);
        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            if (err.code === 'EEXIST') {
                io.stderr.write(`ln: failed to create symbolic link '${linkArg}': File exists\n`);
            } else if (err.code === 'EROFS') {
                io.stderr.write(`ln: cannot create symbolic link '${linkArg}': Read-only filesystem\n`);
            } else {
                io.stderr.write(`ln: ${linkArg}: ${err.message}\n`);
            }
            return 1;
        }
        throw err;
    }
};
