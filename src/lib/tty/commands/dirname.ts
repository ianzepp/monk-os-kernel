/**
 * dirname - Strip last component from filename
 *
 * Usage:
 *   dirname PATH
 *   dirname PATH...
 *
 * Examples:
 *   dirname /usr/bin/cat       # /usr/bin
 *   dirname /home/user/        # /home
 *   dirname file.txt           # .
 *   dirname /                  # /
 */

import type { CommandHandler } from './shared.js';

export const dirname: CommandHandler = async (_session, _fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('dirname: missing operand\n');
        return 1;
    }

    for (const path of args) {
        io.stdout.write(getDirname(path) + '\n');
    }

    return 0;
};

/**
 * Get directory name of a path
 */
function getDirname(path: string): string {
    // Handle root (path is all slashes)
    if (/^\/+$/.test(path)) {
        return '/';
    }

    // Remove trailing slashes
    const p = path.replace(/\/+$/, '');

    // Handle empty string (was just slashes, or empty input)
    if (!p) {
        return '.';
    }

    // Find last slash
    const lastSlash = p.lastIndexOf('/');

    // No slash means current directory
    if (lastSlash === -1) {
        return '.';
    }

    // Slash at start means root
    if (lastSlash === 0) {
        return '/';
    }

    // Return everything before the last slash
    return p.slice(0, lastSlash);
}
