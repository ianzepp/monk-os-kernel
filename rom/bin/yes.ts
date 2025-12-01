/**
 * yes - output a string repeatedly until killed
 *
 * Usage: yes [string...]
 *
 * Args:
 *   string  Text to output (default: "y")
 *
 * Outputs the given string (or "y") repeatedly until the process is
 * terminated. Useful for piping to commands that require confirmation.
 *
 * Examples:
 *   yes | head -5        # Print "y" 5 times
 *   yes hello | head -3  # Print "hello" 3 times
 */

import { getargs, println, exit, onSignal, SIGTERM, sleep } from '/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    const text = args.length > 1 ? args.slice(1).join(' ') : 'y';

    let running = true;

    onSignal((signal) => {
        if (signal === SIGTERM) {
            running = false;
        }
    });

    while (running) {
        await println(text);
        // Yield to event loop periodically to allow signal checks
        await sleep(0);
    }

    await exit(130);
}

main().catch(async (err) => {
    // Broken pipe is expected when piped to head, etc.
    if (err.code === 'EPIPE') {
        await exit(0);
    }
    await exit(1);
});
