/**
 * ls - List directory contents
 *
 * Usage: ls [-l] [-a] [-1] [path...]
 *
 * Options:
 *   -l    Long format (permissions, size, date)
 *   -a    Show hidden files (starting with .)
 *   -1    One entry per line
 *
 * If no path specified, lists current directory.
 */

import {
    getargs,
    getcwd,
    readdirAll,
    stat,
    println,
    eprintln,
    exit,
} from '@os/process';
import { parseArgs, resolvePath, formatMode, formatSize, formatDate } from '@os/shell';

const argSpecs = {
    long: { short: 'l', desc: 'Long format' },
    all: { short: 'a', desc: 'Show hidden files' },
    one: { short: '1', desc: 'One entry per line' },
};

async function listDirectory(
    path: string,
    options: { long: boolean; all: boolean; one: boolean },
    showPath: boolean,
): Promise<number> {
    try {
        if (showPath) {
            await println(`${path}:`);
        }

        const entries = await readdirAll(path);

        // Filter hidden files unless -a
        const filtered = options.all
            ? entries
            : entries.filter(name => !name.startsWith('.'));

        // Sort entries
        filtered.sort((a, b) => a.localeCompare(b));

        if (options.long) {
            await println(`total ${filtered.length}`);
            for (const name of filtered) {
                const entryPath = path === '/' ? `/${name}` : `${path}/${name}`;

                try {
                    const info = await stat(entryPath);
                    const mode = formatMode(info.model === 'folder' ? 'directory' : 'file', 0o755);
                    const size = formatSize(info.size, false);
                    const date = formatDate(new Date(info.mtime));
                    const suffix = info.model === 'folder' ? '/' : '';

                    await println(`${mode}  ${size}  ${date}  ${name}${suffix}`);
                }
                catch {
                    // If stat fails, just show name
                    await println(`??????????        ?           ${name}`);
                }
            }
        }
        else if (options.one) {
            for (const name of filtered) {
                await println(name);
            }
        }
        else {
            // Default: space-separated
            await println(filtered.join('  '));
        }

        return 0;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`ls: ${path}: ${msg}`);

        return 1;
    }
}

async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`ls: ${err}`);
        }

        await exit(1);
    }

    const options = {
        long: Boolean(parsed.flags.long),
        all: Boolean(parsed.flags.all),
        one: Boolean(parsed.flags.one),
    };

    const cwd = await getcwd();
    const targets = parsed.positional.length > 0
        ? parsed.positional
        : ['.'];

    const showPaths = targets.length > 1;
    let exitCode = 0;

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];

        if (target === undefined) {
            continue;
        }

        const resolved = resolvePath(cwd, target);
        const code = await listDirectory(resolved, options, showPaths);

        if (code !== 0) {
            exitCode = code;
        }

        if (i < targets.length - 1) {
            await println('');
        }
    }

    await exit(exitCode);
}

main().catch(async err => {
    await eprintln(`ls: ${err.message}`);
    await exit(1);
});
