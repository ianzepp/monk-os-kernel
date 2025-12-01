/**
 * cp - copy files and directories
 *
 * Usage: cp [OPTIONS] SOURCE DEST
 *        cp [OPTIONS] SOURCE... DIRECTORY
 *
 * Options:
 *   -r, -R   Copy directories recursively
 *
 * Args:
 *   SOURCE   Source file or directory
 *   DEST     Destination file or directory
 *
 * If DEST is an existing directory, copies SOURCE into it.
 * Use -r to copy directories.
 *
 * Examples:
 *   cp /tmp/file.txt /tmp/file2.txt
 *   cp -r /home/root/dir /tmp/backup
 */

import {
    getargs,
    getcwd,
    open,
    read,
    write,
    close,
    stat,
    mkdir,
    readdir,
    eprintln,
    exit,
} from '/lib/process';
import { resolvePath } from '/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse options
    let recursive = false;
    const positional: string[] = [];

    for (const arg of argv) {
        if (arg === '-r' || arg === '-R' || arg === '--recursive') {
            recursive = true;
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (positional.length < 2) {
        await eprintln('cp: missing destination');
        await eprintln('Usage: cp [-r] SOURCE DEST');
        await exit(1);
    }

    const cwd = await getcwd();
    const srcArg = positional[0];
    const destArg = positional[1];

    const src = resolvePath(cwd, srcArg);
    const dest = resolvePath(cwd, destArg);

    try {
        const srcStat = await stat(src);

        if (srcStat.model === 'folder') {
            if (!recursive) {
                await eprintln(`cp: ${srcArg}: is a directory (use -r)`);
                await exit(1);
            }
            await copyDirectory(src, dest, srcArg);
        } else {
            await copyFile(src, dest);
        }

        await exit(0);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`cp: ${srcArg}: ${msg}`);
        await exit(1);
    }
}

/**
 * Copy a single file
 */
async function copyFile(src: string, dest: string): Promise<void> {
    // Check if dest is a directory
    let finalDest = dest;
    try {
        const destStat = await stat(dest);
        if (destStat.model === 'folder') {
            // Copy into directory with same name
            const srcName = src.split('/').pop() || 'file';
            finalDest = dest + '/' + srcName;
        }
    } catch {
        // Dest doesn't exist, use as-is
    }

    // Read source
    const fd = await open(src, { read: true });
    try {
        const chunks: Uint8Array[] = [];
        while (true) {
            const chunk = await read(fd, 65536);
            if (chunk.length === 0) break;
            chunks.push(chunk);
        }

        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const buffer = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
        }

        // Write to destination
        const destFd = await open(finalDest, { write: true, create: true, truncate: true });
        try {
            await write(destFd, buffer);
        } finally {
            await close(destFd);
        }
    } finally {
        await close(fd);
    }
}

/**
 * Copy a directory recursively
 */
async function copyDirectory(src: string, dest: string, srcArg: string): Promise<void> {
    // Create destination directory
    try {
        await mkdir(dest);
    } catch (err) {
        // Ignore if already exists
        if (!(err instanceof Error && err.message.includes('EEXIST'))) {
            // Check if it's because the directory exists
            try {
                const s = await stat(dest);
                if (s.model !== 'folder') {
                    throw err;
                }
            } catch {
                throw err;
            }
        }
    }

    // Copy contents
    const entries = await readdir(src);

    for (const entry of entries) {
        const srcPath = src + '/' + entry;
        const destPath = dest + '/' + entry;

        try {
            const entryStat = await stat(srcPath);

            if (entryStat.model === 'folder') {
                await copyDirectory(srcPath, destPath, srcArg + '/' + entry);
            } else {
                await copyFile(srcPath, destPath);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`cp: ${srcPath}: ${msg}`);
        }
    }
}

main().catch(async (err) => {
    await eprintln(`cp: ${err.message}`);
    await exit(1);
});
