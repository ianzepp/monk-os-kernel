/**
 * basename - Strip directory and suffix from filenames
 *
 * Usage:
 *   basename PATH [SUFFIX]
 *   basename -s SUFFIX PATH...
 *   basename -a PATH...
 *
 * Options:
 *   -a         Process multiple arguments
 *   -s SUFFIX  Remove trailing SUFFIX from each name
 *
 * Examples:
 *   basename /usr/bin/cat           # cat
 *   basename /home/user/file.txt    # file.txt
 *   basename file.txt .txt          # file
 *   basename -s .txt a.txt b.txt    # a\nb
 */

import type { CommandHandler } from './shared.js';

export const basename: CommandHandler = async (_session, _fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('basename: missing operand\n');
        return 1;
    }

    // Parse options
    let suffix = '';
    let multiMode = false;
    const paths: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-a') {
            multiMode = true;
        } else if (arg === '-s' && args[i + 1]) {
            suffix = args[++i];
            multiMode = true;
        } else if (!arg.startsWith('-')) {
            paths.push(arg);
        }
    }

    if (paths.length === 0) {
        io.stderr.write('basename: missing operand\n');
        return 1;
    }

    // Single path mode (traditional)
    if (!multiMode && paths.length <= 2) {
        const path = paths[0];
        const suf = paths[1] || suffix;
        io.stdout.write(getBasename(path, suf) + '\n');
        return 0;
    }

    // Multi-path mode
    for (const path of paths) {
        io.stdout.write(getBasename(path, suffix) + '\n');
    }

    return 0;
};

/**
 * Get basename of a path, optionally removing suffix
 */
function getBasename(path: string, suffix: string): string {
    // Remove trailing slashes
    let p = path.replace(/\/+$/, '');

    // Handle empty or root
    if (!p || p === '/') {
        return '/';
    }

    // Get last component
    const lastSlash = p.lastIndexOf('/');
    let base = lastSlash === -1 ? p : p.slice(lastSlash + 1);

    // Remove suffix if present and not the entire name
    if (suffix && base.endsWith(suffix) && base !== suffix) {
        base = base.slice(0, -suffix.length);
    }

    return base;
}
