/**
 * Init Process
 *
 * The first process (PID 1) in Monk OS.
 * Runs headless - services (telnetd, httpd) provide access.
 *
 * Responsibilities:
 * - Reap zombie children
 * - Stay alive to keep kernel running
 */

import {
    wait,
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
    const pid = await getpid();
    await println(`init: starting (pid ${pid})`);

    // Ignore SIGTERM - init cannot be killed
    onSignal(() => {
        // Silently ignore
    });

    await println('init: running headless (connect via telnet or http)');

    // Reap children forever
    await reapLoop();
}

/**
 * Continuously poll for zombie children and reap them.
 */
async function reapLoop(): Promise<void> {
    while (true) {
        for (const [pid, entry] of children) {
            try {
                const status = await wait(pid);
                await println(`init: reaped ${entry} (pid ${pid}) with code ${status.code}`);
                children.delete(pid);
            } catch (error) {
                if (!(error instanceof ESRCH)) {
                    await eprintln(`init: wait error for pid ${pid}: ${error}`);
                }
            }
        }

        await sleep(100);
    }
}

// Run init
main().catch(async (err) => {
    await eprintln(`init: fatal error: ${err}`);
});
