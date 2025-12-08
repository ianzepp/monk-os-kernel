/**
 * true - do nothing, successfully
 *
 * Usage: true
 *
 * Ignores all arguments.
 * Exit status is always 0.
 */

import { exit } from '@rom/lib/process';

async function main(): Promise<void> {
    await exit(0);
}

main();
