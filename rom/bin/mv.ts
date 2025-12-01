/**
 * mv - move (rename) files
 *
 * Usage: mv SOURCE DEST
 *        mv SOURCE... DIRECTORY
 *
 * Args:
 *   SOURCE   Source file(s) or directory
 *   DEST     Destination file or directory
 *
 * If DEST is an existing directory, moves SOURCE into it.
 * If multiple SOURCEs, DEST must be a directory.
 *
 * Examples:
 *   mv /tmp/file.txt /tmp/file2.txt
 *   mv file1.txt file2.txt /tmp/
 */

import {
    getargs,
    getcwd,
    rename,
    stat,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Filter positional arguments (no options supported yet)
    const files = argv.filter(a => !a.startsWith('-'));

    if (files.length < 2) {
        await eprintln('mv: missing destination');
        await eprintln('Usage: mv SOURCE DEST');
        await exit(1);
    }

    const cwd = await getcwd();
    const destArg = files.pop()!;
    const dest = resolvePath(cwd, destArg);

    // Check if dest is a directory
    let destIsDir = false;
    try {
        const destStat = await stat(dest);
        destIsDir = destStat.model === 'folder';
    } catch {
        // Dest doesn't exist
    }

    // If multiple sources, dest must be a directory
    if (files.length > 1 && !destIsDir) {
        await eprintln(`mv: target '${destArg}' is not a directory`);
        await exit(1);
    }

    let exitCode = 0;

    for (const srcArg of files) {
        const src = resolvePath(cwd, srcArg);
        let finalDest = dest;

        if (destIsDir) {
            // Move into directory with same name
            const srcName = src.split('/').pop() || 'file';
            finalDest = dest + '/' + srcName;
        }

        try {
            await rename(src, finalDest);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`mv: ${srcArg}: ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

main().catch(async (err) => {
    await eprintln(`mv: ${err.message}`);
    await exit(1);
});
