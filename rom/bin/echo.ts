/**
 * echo - Output text
 *
 * Usage: echo [text...]
 *
 * Writes arguments to stdout, separated by spaces, followed by newline.
 */

import { getargs, println, exit } from '@rom/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    // args[0] is the command name, rest are arguments
    const text = args.slice(1).join(' ');
    await println(text);
    await exit(0);
}

main().catch(async (err) => {
    console.error('echo:', err.message);
    await exit(1);
});
