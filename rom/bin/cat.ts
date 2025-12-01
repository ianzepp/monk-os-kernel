/**
 * cat - Concatenate and display files
 *
 * Usage: cat [file...]
 *
 * If no files specified, reads from stdin (fd 0).
 * Writes file contents to stdout (fd 1).
 */

import {
    getargs,
    getcwd,
    open,
    read,
    write,
    close,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const files = args.slice(1); // Skip argv[0]

    // No files: pass through stdin
    if (files.length === 0) {
        for await (const chunk of read(0)) {
            await write(1, chunk);
        }
        await exit(0);
    }

    const cwd = await getcwd();
    let exitCode = 0;

    for (const file of files) {
        const path = resolvePath(cwd, file);

        try {
            const fd = await open(path, { read: true });
            try {
                for await (const chunk of read(fd)) {
                    await write(1, chunk);
                }
            } finally {
                await close(fd);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`cat: ${file}: ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

main().catch(async (err) => {
    await eprintln(`cat: ${err.message}`);
    await exit(1);
});
