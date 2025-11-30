/**
 * Test Echo Process
 *
 * Minimal process for boot testing.
 * Makes a syscall, logs result, exits.
 */

import { getpid, println, exit } from '@src/process/index.js';

async function main(): Promise<void> {
    const pid = await getpid();
    await println(`test-echo: pid=${pid}`);
    await exit(42); // Distinctive exit code for testing
}

main().catch(async (err) => {
    console.error('test-echo failed:', err);
    await exit(1);
});
