/**
 * whoami - print effective user name
 *
 * Usage: whoami
 *
 * Prints the user name associated with the current effective user ID.
 * Gets the username from the USER environment variable.
 *
 * Examples:
 *   whoami
 */

import { getenv, println, exit } from '@os/process';

async function main(): Promise<void> {
    const user = await getenv('USER') || 'unknown';

    await println(user);
    await exit(0);
}

main().catch(async () => {
    await exit(1);
});
