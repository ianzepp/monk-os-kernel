/**
 * dirname - strip last component from filename
 *
 * Usage: dirname PATH...
 *
 * Args:
 *   PATH  Pathname(s) to process
 *
 * Output parent directory of each PATH. If PATH has no slashes,
 * output '.'. Multiple PATHs are processed one per line.
 *
 * Examples:
 *   dirname /usr/bin/cat       # /usr/bin
 *   dirname /home/user/        # /home
 *   dirname file.txt           # .
 *   dirname /                  # /
 */

import { getargs, println, eprintln, exit } from '@rom/lib/process';

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

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0) {
        await eprintln('dirname: missing operand');
        await exit(1);
    }

    for (const path of argv) {
        await println(getDirname(path));
    }

    await exit(0);
}

main().catch(async err => {
    await eprintln(`dirname: ${err.message}`);
    await exit(1);
});
