/**
 * yes - output a string repeatedly until killed
 *
 * Usage:
 *   yes [string]
 *
 * Outputs "y" (or the given string) repeatedly until interrupted.
 * Useful for piping to commands that require confirmation.
 *
 * Examples:
 *   yes | head -5        # Print "y" 5 times
 *   yes hello | head -3  # Print "hello" 3 times
 */

import type { CommandHandler } from './shared.js';

export const yes: CommandHandler = async (session, fs, args, io) => {
    const text = args.length > 0 ? args.join(' ') : 'y';

    // Output until aborted
    while (!io.signal?.aborted) {
        io.stdout.write(text + '\n');

        // Yield to event loop periodically to allow signal checks
        await new Promise(resolve => setImmediate(resolve));
    }

    return 130;
};
