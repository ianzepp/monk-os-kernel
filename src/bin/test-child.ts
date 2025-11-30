/**
 * Test Child Process
 *
 * A child process that exits with a code based on env var.
 * Used to test spawn/wait from parent.
 */

import { getpid, getppid, println, exit, getenv } from '@src/process/index.js';

async function main(): Promise<void> {
    const pid = await getpid();
    const ppid = await getppid();
    const exitCode = parseInt(await getenv('EXIT_CODE') ?? '0', 10);

    await println(`child: pid=${pid} ppid=${ppid} will-exit=${exitCode}`);
    await exit(exitCode);
}

main().catch(async (err) => {
    console.error('test-child failed:', err);
    await exit(1);
});
