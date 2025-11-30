/**
 * mkdir - Create directories
 *
 * Usage: mkdir [-p] directory...
 *
 * Options:
 *   -p    Create parent directories as needed
 */

import {
    getargs,
    getcwd,
    stat,
    mkdir,
    eprintln,
    exit,
} from '@src/process/index.js';
import { parseArgs, resolvePath, dirname } from '@src/lib/shell/index.js';

const argSpecs = {
    parents: { short: 'p', desc: 'Create parent directories as needed' },
};

async function mkdirParents(path: string): Promise<void> {
    // Try to create the directory
    try {
        await mkdir(path);
        return;
    } catch (err) {
        // If parent doesn't exist, try creating it first
        const parent = dirname(path);
        if (parent !== path && parent !== '/') {
            await mkdirParents(parent);
            await mkdir(path);
            return;
        }
        throw err;
    }
}

async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`mkdir: ${err}`);
        }
        await exit(1);
    }

    const parents = Boolean(parsed.flags.parents);

    if (parsed.positional.length === 0) {
        await eprintln('mkdir: missing operand');
        await exit(1);
    }

    const cwd = await getcwd();
    let exitCode = 0;

    for (const target of parsed.positional) {
        const path = resolvePath(cwd, target);

        try {
            if (parents) {
                // Check if already exists
                try {
                    const info = await stat(path);
                    if (info.model === 'folder') {
                        continue; // Already exists, no error with -p
                    }
                    await eprintln(`mkdir: ${target}: exists but is not a directory`);
                    exitCode = 1;
                    continue;
                } catch {
                    // Doesn't exist, create it
                    await mkdirParents(path);
                }
            } else {
                await mkdir(path);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`mkdir: ${target}: ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

main().catch(async (err) => {
    await eprintln(`mkdir: ${err.message}`);
    await exit(1);
});
