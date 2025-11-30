/**
 * history - Display command history
 *
 * Usage:
 *   history          Show all history
 *   history N        Show last N entries
 *   history -c       Clear history
 *
 * Examples:
 *   history
 *   history 10
 *   history -c
 */

import type { CommandHandler } from './shared.js';

export const history: CommandHandler = async (session, _fs, args, io) => {
    // Parse options
    const clearHistory = args.includes('-c');
    const countArg = args.find(a => !a.startsWith('-'));
    const count = countArg ? parseInt(countArg, 10) : undefined;

    if (clearHistory) {
        session.history = [];
        io.stdout.write('History cleared\n');
        return 0;
    }

    if (count !== undefined && (isNaN(count) || count < 0)) {
        io.stderr.write(`history: invalid count: '${countArg}'\n`);
        return 1;
    }

    const history = session.history;

    if (history.length === 0) {
        return 0;
    }

    // Determine range to show
    const start = count !== undefined ? Math.max(0, history.length - count) : 0;

    for (let i = start; i < history.length; i++) {
        const num = String(i + 1).padStart(5);
        io.stdout.write(`${num}  ${history[i]}\n`);
    }

    return 0;
};
