/**
 * ln - make links between files
 *
 * Usage: ln [-s] TARGET LINK_NAME
 *
 * Options:
 *   -s   Create symbolic link (default, hard links not supported)
 *
 * Note: Symbolic links are not currently supported in Monk OS.
 * This command exists for compatibility but will return EPERM.
 */

import {
    getargs,
    getcwd,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';
import { symlink } from '@rom/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse options
    const positional: string[] = [];

    for (const arg of argv) {
        if (arg === '-s' || arg === '--symbolic') {
            // Symbolic links are always used (hard links not supported)
            continue;
        }
        else if (arg === '-h' || arg === '--help') {
            await eprintln('Usage: ln [-s] TARGET LINK_NAME');
            await eprintln('Create a link to TARGET with the name LINK_NAME.');
            await eprintln('');
            await eprintln('Options:');
            await eprintln('  -s, --symbolic   Create symbolic link');
            await eprintln('');
            await eprintln('Note: Symbolic links are not currently supported.');
            await exit(0);
        }
        else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
        else {
            await eprintln(`ln: invalid option: ${arg}`);
            await exit(1);
        }
    }

    if (positional.length < 2) {
        await eprintln('ln: missing file operand');
        await eprintln('Usage: ln [-s] TARGET LINK_NAME');
        await exit(1);
    }

    const cwd = await getcwd();
    const target = positional[0];
    const linkNameArg = positional[1];

    if (target === undefined || linkNameArg === undefined) {
        await eprintln('ln: missing file operand');

        return await exit(1);
    }

    const linkName = resolvePath(cwd, linkNameArg);

    try {
        // Always treat as symbolic link (hard links not supported)
        await symlink(target, linkName);
        await exit(0);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`ln: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`ln: ${err.message}`);
    await exit(1);
});
