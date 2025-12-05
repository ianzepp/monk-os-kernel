/**
 * realpath - print resolved absolute path
 *
 * Usage: realpath [options] <file...>
 *
 * Options:
 *   -e              All path components must exist
 *   -m              No path components need exist (default)
 *   -q              Quiet (suppress errors)
 *   --relative-to=<dir>   Print relative to directory
 *
 * Examples:
 *   realpath .
 *   realpath ../foo/bar
 *   realpath -e /home/user/file.txt
 */

import {
    getargs,
    getcwd,
    stat,
    println,
    eprintln,
    exit,
} from '@os/process';
import { resolvePath } from '@os/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0) {
        await eprintln('realpath: missing operand');
        await eprintln('Usage: realpath [options] <file...>');
        await exit(1);
    }

    if (argv[0] === '-h' || argv[0] === '--help') {
        await println('Usage: realpath [options] <file...>');
        await println('Options: -e (must exist), -m (may not exist), -q (quiet)');
        await println('         --relative-to=<dir>');
        await exit(0);
    }

    // Parse options
    let mustExist = false;
    let quiet = false;
    let relativeTo: string | null = null;
    const files: string[] = [];

    for (const arg of argv) {
        if (arg === '-e') {
            mustExist = true;
        }
        else if (arg === '-m') {
            mustExist = false;
        }
        else if (arg === '-q') {
            quiet = true;
        }
        else if (arg.startsWith('--relative-to=')) {
            relativeTo = arg.slice(14);
        }
        else if (!arg.startsWith('-')) {
            files.push(arg);
        }
    }

    if (files.length === 0) {
        await eprintln('realpath: missing operand');
        await exit(1);
    }

    const cwd = await getcwd();

    if (relativeTo) {
        relativeTo = resolvePath(cwd, relativeTo);
    }

    let exitCode = 0;

    for (const file of files) {
        try {
            const resolved = resolvePath(cwd, file);

            // Verify existence if required
            if (mustExist) {
                await stat(resolved);
            }

            let output = resolved;

            if (relativeTo) {
                output = makeRelative(resolved, relativeTo);
            }

            await println(output);
        }
        catch (err) {
            if (!quiet) {
                const msg = err instanceof Error ? err.message : String(err);

                await eprintln(`realpath: ${file}: ${msg}`);
            }

            exitCode = 1;
        }
    }

    await exit(exitCode);
}

function makeRelative(path: string, base: string): string {
    const pathParts = path.split('/').filter(p => p);
    const baseParts = base.split('/').filter(p => p);

    let common = 0;

    while (common < pathParts.length && common < baseParts.length) {
        if (pathParts[common] !== baseParts[common]) {
            break;
        }

        common++;
    }

    const ups = baseParts.length - common;
    const downs = pathParts.slice(common);

    const parts: string[] = [];

    for (let i = 0; i < ups; i++) {
        parts.push('..');
    }

    parts.push(...downs);

    return parts.join('/') || '.';
}

main().catch(async err => {
    await eprintln(`realpath: ${err.message}`);
    await exit(1);
});
