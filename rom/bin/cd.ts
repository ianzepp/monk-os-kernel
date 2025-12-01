/**
 * cd - Change directory
 *
 * Usage: cd [path]
 *
 * Changes the current working directory.
 * If no path specified, changes to HOME (or / if HOME not set).
 *
 * Note: In a traditional shell, cd is a builtin because it needs to
 * change the shell's own cwd. This command changes the process cwd
 * and is mainly useful for testing the chdir syscall.
 */

import {
    getargs,
    getcwd,
    getenv,
    chdir,
    stat,
    println,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const target = args[1]; // First argument after command name

    let path: string;

    if (!target) {
        // No argument: go to HOME or /
        const home = await getenv('HOME');
        path = home ?? '/';
    } else if (target === '-') {
        // cd - : go to OLDPWD
        const oldpwd = await getenv('OLDPWD');
        if (!oldpwd) {
            await eprintln('cd: OLDPWD not set');
            return exit(1);
        }
        path = oldpwd;
    } else {
        const cwd = await getcwd();
        path = resolvePath(cwd, target);
    }

    // Verify path exists and is a directory
    try {
        const info = await stat(path);
        if (info.model !== 'folder') {
            await eprintln(`cd: ${target}: Not a directory`);
            await exit(1);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`cd: ${target}: ${msg}`);
        await exit(1);
    }

    // Change directory
    await chdir(path);

    // Print new directory (useful for shell to capture)
    await println(path);

    await exit(0);
}

main().catch(async (err) => {
    await eprintln(`cd: ${err.message}`);
    await exit(1);
});
