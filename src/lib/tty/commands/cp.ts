/**
 * cp - Copy files
 *
 * Usage:
 *   cp <source> <dest>       Copy file to destination
 *   cp -r <source> <dest>    Copy directory recursively
 *
 * Examples:
 *   cp /tmp/file.txt /tmp/file2.txt
 *   cp -r /home/root/dir /tmp/backup
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FS } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import type { CommandIO } from '../types.js';

export const cp: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('cp: filesystem not available\n');
        return 1;
    }

    // Parse options
    const recursive = args.includes('-r') || args.includes('-R') || args.includes('--recursive');
    const positional = args.filter(a => !a.startsWith('-'));

    if (positional.length < 2) {
        io.stderr.write('cp: missing destination\n');
        io.stderr.write('Usage: cp [-r] <source> <dest>\n');
        return 1;
    }

    const srcArg = positional[0];
    const destArg = positional[1];

    const src = resolvePath(session.cwd, srcArg);
    const dest = resolvePath(session.cwd, destArg);

    try {
        const srcStat = await fs.stat(src);

        if (srcStat.type === 'directory') {
            if (!recursive) {
                io.stderr.write(`cp: ${srcArg}: is a directory (use -r)\n`);
                return 1;
            }
            await copyDirectory(fs, src, dest, io);
        } else {
            await copyFile(fs, src, dest);
        }

        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`cp: ${srcArg}: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
};

/**
 * Copy a single file
 */
async function copyFile(fs: FS, src: string, dest: string): Promise<void> {
    // Check if dest is a directory
    let finalDest = dest;
    try {
        const destStat = await fs.stat(dest);
        if (destStat.type === 'directory') {
            // Copy into directory with same name
            const srcName = src.split('/').pop() || 'file';
            finalDest = dest + '/' + srcName;
        }
    } catch {
        // Dest doesn't exist, use as-is
    }

    const content = await fs.read(src);
    await fs.write(finalDest, content);
}

/**
 * Copy a directory recursively
 */
async function copyDirectory(fs: FS, src: string, dest: string, io: CommandIO): Promise<void> {
    // Create destination directory
    try {
        await fs.mkdir(dest);
    } catch (err) {
        if (!(err instanceof FSError && err.code === 'EEXIST')) {
            throw err;
        }
    }

    // Copy contents
    const entries = await fs.readdir(src);

    for (const entry of entries) {
        const srcPath = src + '/' + entry.name;
        const destPath = dest + '/' + entry.name;

        if (entry.type === 'directory') {
            await copyDirectory(fs, srcPath, destPath, io);
        } else {
            try {
                const content = await fs.read(srcPath);
                await fs.write(destPath, content);
            } catch (err) {
                if (err instanceof FSError) {
                    io.stderr.write(`cp: ${srcPath}: ${err.message}\n`);
                } else {
                    throw err;
                }
            }
        }
    }
}
