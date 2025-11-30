/**
 * Init Process
 *
 * The first process (PID 1) in Monk OS.
 * Responsibilities:
 * - Spawn the shell on console
 * - Reap zombie children
 * - Cannot be killed (ignores SIGTERM)
 *
 * This is a minimal init - no daemon management, no service config.
 * Those are userland concerns for later.
 */

import {
    spawn,
    wait,
    exit,
    onSignal,
    sleep,
    getpid,
    println,
    eprintln,
    ESRCH,
} from '/lib/process';

/**
 * Child process tracking
 */
const children = new Map<number, string>(); // pid -> entry name

/**
 * Main init loop
 */
async function main(): Promise<void> {
    // Log startup
    const pid = await getpid();
    await println(`init: starting (pid ${pid})`);

    // Ignore SIGTERM - init cannot be killed
    onSignal(() => {
        // Silently ignore
    });

    // Spawn shell on console
    // TODO: For now, just log that we would spawn shell
    // const shellPid = await spawn('/bin/shell');
    // children.set(shellPid, '/bin/shell');
    await println('init: shell spawn deferred (not yet implemented)');

    // Reap children forever
    await println('init: entering reap loop');
    await reapLoop();
}

/**
 * Continuously poll for zombie children and reap them.
 *
 * This is a simple polling approach. A future wait(-1) syscall
 * would allow blocking until any child exits.
 */
async function reapLoop(): Promise<void> {
    while (true) {
        // Try to wait on each known child
        for (const [pid, entry] of children) {
            try {
                const status = await wait(pid);
                await println(`init: reaped ${entry} (pid ${pid}) with code ${status.code}`);
                children.delete(pid);
            } catch (error) {
                // ESRCH means process doesn't exist or isn't zombie yet
                // Any other error is unexpected
                if (!(error instanceof ESRCH)) {
                    await eprintln(`init: wait error for pid ${pid}: ${error}`);
                }
            }
        }

        // Sleep before next poll
        await sleep(100);
    }
}

// Run init
main().catch(async (err) => {
    await eprintln(`init: fatal error: ${err}`);
    await exit(1);
});
