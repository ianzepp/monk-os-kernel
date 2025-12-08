/**
 * rmdir - Remove empty directories
 *
 * Usage: rmdir directory...
 *
 * Removes the specified directories if they are empty.
 * For recursive removal, use rm -r instead.
 */

import {
    getargs,
    getcwd,
    rmdir,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const targets = args.slice(1); // Skip argv[0]

    if (targets.length === 0) {
        await eprintln('rmdir: missing operand');
        await exit(1);
    }

    const cwd = await getcwd();
    let exitCode = 0;

    for (const target of targets) {
        const path = resolvePath(cwd, target);

        try {
            await rmdir(path);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`rmdir: ${target}: ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

main().catch(async err => {
    await eprintln(`rmdir: ${err.message}`);
    await exit(1);
});
