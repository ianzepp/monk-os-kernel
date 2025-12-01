/**
 * rm - Remove files
 *
 * Usage: rm [-r] [-f] file...
 *
 * Options:
 *   -r, -R    Remove directories recursively
 *   -f        Force - ignore nonexistent files, never prompt
 */

import {
    getargs,
    getcwd,
    stat,
    readdirAll,
    unlink,
    rmdir,
    eprintln,
    exit,
} from '@rom/lib/process';
import { parseArgs, resolvePath } from '@rom/lib/shell';

const argSpecs = {
    recursive: { short: 'r', desc: 'Remove directories recursively' },
    recursiveAlt: { short: 'R', desc: 'Remove directories recursively' },
    force: { short: 'f', desc: 'Force removal' },
};

async function removeRecursive(path: string): Promise<void> {
    const info = await stat(path);

    if (info.model === 'folder') {
        // Remove contents first
        const entries = await readdirAll(path);
        for (const name of entries) {
            const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
            await removeRecursive(childPath);
        }
        // Then remove the directory
        await rmdir(path);
    } else {
        await unlink(path);
    }
}

async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`rm: ${err}`);
        }
        await exit(1);
    }

    const recursive = Boolean(parsed.flags.recursive) || Boolean(parsed.flags.recursiveAlt);
    const force = Boolean(parsed.flags.force);

    if (parsed.positional.length === 0) {
        await eprintln('rm: missing operand');
        await exit(1);
    }

    const cwd = await getcwd();
    let exitCode = 0;

    for (const target of parsed.positional) {
        const path = resolvePath(cwd, target);

        try {
            const info = await stat(path);

            if (info.model === 'folder') {
                if (!recursive) {
                    await eprintln(`rm: ${target}: is a directory`);
                    exitCode = 1;
                    continue;
                }
                await removeRecursive(path);
            } else {
                await unlink(path);
            }
        } catch (err) {
            if (!force) {
                const msg = err instanceof Error ? err.message : String(err);
                await eprintln(`rm: ${target}: ${msg}`);
                exitCode = 1;
            }
        }
    }

    await exit(exitCode);
}

main().catch(async (err) => {
    await eprintln(`rm: ${err.message}`);
    await exit(1);
});
