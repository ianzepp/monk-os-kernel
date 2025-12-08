/**
 * false - do nothing, unsuccessfully
 *
 * Usage: false
 *
 * Ignores all arguments.
 * Exit status is always 1.
 */

import { exit } from '@rom/lib/process/index.js';

async function main(): Promise<void> {
    await exit(1);
}

main();
