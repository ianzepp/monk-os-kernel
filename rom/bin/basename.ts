/**
 * basename - strip directory and suffix from filenames
 *
 * Usage: basename PATH [SUFFIX]
 *        basename -s SUFFIX PATH...
 *        basename -a PATH...
 *
 * Options:
 *   -a          Process multiple arguments
 *   -s SUFFIX   Remove trailing SUFFIX from each name
 *
 * Args:
 *   PATH    Pathname to process
 *   SUFFIX  Suffix to remove from filename
 *
 * Examples:
 *   basename /usr/bin/cat           # cat
 *   basename /home/user/file.txt    # file.txt
 *   basename file.txt .txt          # file
 *   basename -s .txt a.txt b.txt    # a\nb
 */

import { getargs, println, eprintln, exit } from '@rom/lib/process/index.js';

/**
 * Get basename of a path, optionally removing suffix
 */
function getBasename(path: string, suffix: string): string {
    // Remove trailing slashes
    const p = path.replace(/\/+$/, '');

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

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0) {
        await eprintln('basename: missing operand');
        await exit(1);
    }

    // Parse options
    let suffix = '';
    let multiMode = false;
    const paths: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === undefined) {
            continue;
        }

        if (arg === '-a') {
            multiMode = true;
        }
        else if (arg === '-s' && argv[i + 1]) {
            const val = argv[++i];

            if (val === undefined) {
                continue;
            }

            suffix = val;
            multiMode = true;
        }
        else if (!arg.startsWith('-')) {
            paths.push(arg);
        }
    }

    if (paths.length === 0) {
        await eprintln('basename: missing operand');
        await exit(1);
    }

    // Single path mode (traditional)
    if (!multiMode && paths.length <= 2) {
        const path = paths[0];

        if (path === undefined) {
            await eprintln('basename: missing operand');

            return await exit(1);
        }

        const suf = paths[1] || suffix;

        await println(getBasename(path, suf));
        await exit(0);
    }

    // Multi-path mode
    for (const path of paths) {
        await println(getBasename(path, suffix));
    }

    await exit(0);
}

main().catch(async err => {
    await eprintln(`basename: ${err.message}`);
    await exit(1);
});
