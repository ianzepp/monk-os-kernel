/**
 * sleep - delay for a specified amount of time
 *
 * Usage: sleep DURATION
 *
 * Args:
 *   DURATION  Time to sleep: NUMBER[SUFFIX]
 *             SUFFIX may be 's' (seconds, default), 'ms' (milliseconds),
 *             'm' (minutes), or 'h' (hours).
 *
 * Examples:
 *   sleep 5       # Sleep 5 seconds
 *   sleep 5s      # Sleep 5 seconds
 *   sleep 500ms   # Sleep 500 milliseconds
 *   sleep 1m      # Sleep 1 minute
 *   sleep 0.5     # Sleep 500 milliseconds
 */

import { getargs, eprintln, exit, onSignal, SIGTERM, sleep } from '@rom/lib/process';
import { parseDuration } from '@rom/lib/args';

async function main(): Promise<void> {
    const args = await getargs();

    const durationArg = args[1];
    if (durationArg === undefined) {
        await eprintln('sleep: missing operand');
        await eprintln('Usage: sleep DURATION');
        return await exit(1);
    }

    const duration = parseDuration(durationArg);
    if (duration === null) {
        await eprintln(`sleep: invalid time interval '${durationArg}'`);
        return await exit(1);
    }

    // Cap at 1 hour for safety
    const capped = Math.min(duration, 60 * 60 * 1000);

    let interrupted = false;
    onSignal((signal) => {
        if (signal === SIGTERM) {
            interrupted = true;
        }
    });

    // Sleep in small intervals to allow signal checking
    const interval = 100;
    let remaining = capped;

    while (remaining > 0 && !interrupted) {
        const sleepTime = Math.min(interval, remaining);
        await sleep(sleepTime);
        remaining -= sleepTime;
    }

    if (interrupted) {
        await exit(130);
    }

    await exit(0);
}

main().catch(async (err) => {
    await eprintln(`sleep: ${err.message}`);
    await exit(1);
});
