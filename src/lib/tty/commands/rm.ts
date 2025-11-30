/**
 * rm - Remove files or directories
 *
 * Usage:
 *   rm [-rf] <file>...
 *
 * Options:
 *   -r, -R    Remove directories and their contents recursively
 *   -f        Ignore nonexistent files, never prompt
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FS } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

/**
 * Recursively remove a directory and its contents
 */
async function removeRecursive(fs: FS, path: string): Promise<void> {
    const stat = await fs.stat(path);

    if (stat.type === 'directory') {
        const entries = await fs.readdir(path);
        for (const entry of entries) {
            const childPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
            await removeRecursive(fs, childPath);
        }
        await fs.rmdir(path);
    } else {
        await fs.unlink(path);
    }
}

export const rm: CommandHandler = async (session, fs, args, io) => {
    let force = false;
    let recursive = false;
    const files: string[] = [];

    for (const arg of args) {
        if (arg === '-f') {
            force = true;
        } else if (arg === '-r' || arg === '-R') {
            recursive = true;
        } else if (arg === '-rf' || arg === '-fr' || arg === '-Rf' || arg === '-fR') {
            force = true;
            recursive = true;
        } else if (!arg.startsWith('-')) {
            files.push(arg);
        }
    }

    if (files.length === 0) {
        io.stderr.write('rm: missing operand\n');
        return 1;
    }

    let exitCode = 0;
    for (const file of files) {
        const resolved = resolvePath(session.cwd, file);

        try {
            const stat = await fs!.stat(resolved);

            if (stat.type === 'directory') {
                if (!recursive) {
                    io.stderr.write(`rm: ${file}: EISDIR: ${resolved}\n`);
                    exitCode = 1;
                    continue;
                }
                await removeRecursive(fs!, resolved);
            } else {
                await fs!.unlink(resolved);
            }
        } catch (err) {
            if (err instanceof FSError) {
                if (!force) {
                    io.stderr.write(`rm: ${file}: ${err.message}\n`);
                    exitCode = 1;
                }
            } else {
                throw err;
            }
        }
    }
    return exitCode;
};
