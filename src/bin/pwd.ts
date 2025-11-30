/**
 * pwd - Print working directory
 *
 * Usage: pwd
 *
 * Prints the current working directory to stdout.
 */

import { getcwd, println, exit } from '@src/process/index.js';

async function main(): Promise<void> {
    const cwd = await getcwd();
    await println(cwd);
    await exit(0);
}

main().catch(async (err) => {
    const { eprintln } = await import('@src/process/index.js');
    await eprintln(`pwd: ${err.message}`);
    await exit(1);
});
