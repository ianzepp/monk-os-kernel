/**
 * Kill stale processes and free ports used by Monk OS.
 *
 * Terminates:
 * - Processes listening on port 7777 (Prior HTTP server)
 * - Any orphaned bun processes from this project
 */

import { $ } from 'bun';

const PORTS = [7777];

async function killPort(port: number): Promise<boolean> {
    const result = await $`lsof -ti :${port}`.quiet().nothrow();
    const pids = result.stdout.toString().trim().split('\n').filter(Boolean);

    if (pids.length === 0) {
        return false;
    }

    for (const pid of pids) {
        await $`kill -9 ${pid}`.quiet().nothrow();
        console.log(`Killed PID ${pid} on port ${port}`);
    }

    return true;
}

async function main(): Promise<void> {
    let killed = false;

    for (const port of PORTS) {
        if (await killPort(port)) {
            killed = true;
        }
    }

    if (!killed) {
        console.log('No processes to kill');
    }
}

await main();
