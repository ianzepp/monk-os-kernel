/**
 * sleep - Delay for a specified time
 */

import type { CommandHandler } from './shared.js';
import { parseDuration } from './shared.js';

export const sleep: CommandHandler = async (_session, _fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('sleep: missing operand\n');
        io.stderr.write('Usage: sleep DURATION\n');
        return 1;
    }

    const duration = parseDuration(args[0]);
    if (duration === null) {
        io.stderr.write(`sleep: invalid time interval '${args[0]}'\n`);
        return 1;
    }

    // Cap at 1 hour
    const capped = Math.min(duration, 60 * 60 * 1000);

    // Sleep in small intervals to allow abort signal checking
    const interval = 100; // ms
    let remaining = capped;
    while (remaining > 0) {
        if (io.signal?.aborted) {
            return 130; // Interrupted
        }
        const sleepTime = Math.min(interval, remaining);
        await new Promise((resolve) => setTimeout(resolve, sleepTime));
        remaining -= sleepTime;
    }
    return 0;
};
