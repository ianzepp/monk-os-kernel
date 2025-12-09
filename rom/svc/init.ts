/**
 * Init Process
 *
 * The first process (PID 1) in Monk OS.
 * Spawns system services and reaps zombie children.
 *
 * Responsibilities:
 * - Spawn system services (Prior, etc.)
 * - Reap zombie children
 * - Stay alive to keep kernel running
 */

import {
    wait,
    spawn,
    onSignal,
    sleep,
    getpid,
    println,
    eprintln,
    ESRCH,
} from '@rom/lib/process/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * System services to spawn at boot.
 * Each entry is [path, description].
 */
const SYSTEM_SERVICES: [string, string][] = [
    ['/bin/prior.ts', 'prior'],
];

// =============================================================================
// STATE
// =============================================================================

/**
 * Child process tracking
 */
const children = new Map<number, string>(); // pid -> entry name

// =============================================================================
// SERVICE MANAGEMENT
// =============================================================================

/**
 * Spawn a system service.
 */
async function spawnService(path: string, name: string): Promise<void> {
    try {
        const pid = await spawn(path);

        children.set(pid, name);
        await println(`init: started ${name} (pid ${pid})`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`init: failed to start ${name}: ${message}`);
    }
}

/**
 * Spawn all system services.
 */
async function spawnServices(): Promise<void> {
    for (const [path, name] of SYSTEM_SERVICES) {
        await spawnService(path, name);
    }
}

// =============================================================================
// MAIN
// =============================================================================

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

    // Spawn system services
    await spawnServices();

    await println('init: all services started');

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
            }
            catch (error: unknown) {
                // ESRCH = No such process (already exited)
                if (!(error instanceof ESRCH)) {
                    await eprintln(`init: wait error for pid ${pid}: ${error}`);
                }
            }
        }

        await sleep(100);
    }
}

// Run init
main().catch(async err => {
    await eprintln(`init: fatal error: ${err}`);
});
