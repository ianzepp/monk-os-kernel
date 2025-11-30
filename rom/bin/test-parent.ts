/**
 * Test Parent Process
 *
 * Spawns a child process, waits for it, reports the exit status.
 * Tests spawn() and wait() syscalls.
 */

import { getpid, spawn, wait, println, exit, getenv } from '/lib/process';

async function main(): Promise<void> {
    const pid = await getpid();
    await println(`parent: pid=${pid} starting`);

    // Get child path from env, or use default
    const childPath = await getenv('CHILD_PATH') ?? '/bin/test-child.ts';
    const childExitCode = await getenv('CHILD_EXIT_CODE') ?? '42';

    await println(`parent: spawning ${childPath}`);

    // Spawn child with EXIT_CODE env var
    const childPid = await spawn(childPath, {
        env: { EXIT_CODE: childExitCode },
    });

    await println(`parent: spawned child pid=${childPid}, waiting...`);

    // Wait for child
    const status = await wait(childPid);

    await println(`parent: child exited with code=${status.code}`);

    // Exit with child's code to propagate result
    await exit(status.code);
}

main().catch(async (err) => {
    console.error('test-parent failed:', err);
    await exit(1);
});
