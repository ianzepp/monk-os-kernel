/**
 * tee - read from stdin and write to stdout and files
 *
 * Usage: tee [OPTIONS] FILE...
 *
 * Options:
 *   -a   Append to files instead of overwriting
 *
 * Args:
 *   FILE   File(s) to write to
 *
 * Copies stdin to stdout and also writes to each FILE.
 * Useful for saving intermediate output in a pipeline.
 *
 * Examples:
 *   find . | tee /tmp/files.txt
 *   cat file | tee -a /tmp/log.txt
 */

import {
    getargs,
    getcwd,
    open,
    read,
    readFileBytes,
    write,
    close,
    eprintln,
    exit,
} from '/lib/process';
import { resolvePath } from '/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse options
    const append = argv.includes('-a') || argv.includes('--append');
    const files = argv.filter(a => !a.startsWith('-'));

    if (files.length === 0) {
        await eprintln('tee: missing file operand');
        await eprintln('Usage: tee [-a] FILE...');
        await exit(1);
    }

    const cwd = await getcwd();

    // Read stdin and write to stdout simultaneously, collecting for files
    const chunks: Uint8Array[] = [];
    for await (const chunk of read(0)) {
        chunks.push(chunk);
        await write(1, chunk);
    }

    // Combine all chunks
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const content = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
    }

    // Write to each file
    let exitCode = 0;

    for (const fileArg of files) {
        const filePath = resolvePath(cwd, fileArg);

        try {
            let finalContent = content;

            if (append) {
                // Read existing content and append
                try {
                    const existing = await readFileBytes(filePath);
                    if (existing.length > 0) {
                        finalContent = new Uint8Array(existing.length + total);
                        finalContent.set(existing, 0);
                        finalContent.set(content, existing.length);
                    }
                } catch {
                    // File doesn't exist, that's fine
                }
            }

            const fd = await open(filePath, { write: true, create: true, truncate: true });
            try {
                await write(fd, finalContent);
            } finally {
                await close(fd);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`tee: ${fileArg}: ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

main().catch(async (err) => {
    await eprintln(`tee: ${err.message}`);
    await exit(1);
});
