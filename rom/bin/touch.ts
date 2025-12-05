/**
 * touch - Create files or update timestamps
 *
 * Usage: touch file...
 *
 * Creates empty files if they don't exist.
 * Updates modification time if they do exist.
 */

import {
    getargs,
    getcwd,
    stat,
    open,
    close,
    eprintln,
    exit,
} from '@os/process';
import { resolvePath } from '@os/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const targets = args.slice(1); // Skip argv[0]

    if (targets.length === 0) {
        await eprintln('touch: missing file operand');
        await exit(1);
    }

    const cwd = await getcwd();
    let exitCode = 0;

    for (const target of targets) {
        const path = resolvePath(cwd, target);

        try {
            // Check if file exists
            try {
                await stat(path);
                // File exists - TODO: update mtime when VFS supports it
                // For now, just succeed silently
            }
            catch {
                // File doesn't exist, create it
                const fd = await open(path, { write: true, create: true });

                await close(fd);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`touch: ${target}: ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

main().catch(async err => {
    await eprintln(`touch: ${err.message}`);
    await exit(1);
});
