/**
 * debug - Toggle AI debug mode
 *
 * Usage:
 *   debug on       Enable debug output
 *   debug off      Disable debug output
 *   debug          Show current status
 *
 * When enabled, AI mode shows network traffic:
 *   -> (outgoing request JSON)
 *   <- (incoming response JSON)
 */

import type { CommandHandler } from './shared.js';

export const debug: CommandHandler = async (session, _fs, args, io) => {
    const arg = args[0]?.toLowerCase();

    if (arg === 'on') {
        session.debugMode = true;
        io.stdout.write('Debug mode enabled\n');
        return 0;
    }

    if (arg === 'off') {
        session.debugMode = false;
        io.stdout.write('Debug mode disabled\n');
        return 0;
    }

    if (!arg) {
        io.stdout.write(`Debug mode: ${session.debugMode ? 'on' : 'off'}\n`);
        return 0;
    }

    io.stderr.write('Usage: debug [on|off]\n');
    return 1;
};
