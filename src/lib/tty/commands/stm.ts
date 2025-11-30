/**
 * stm - Short Term Memory
 *
 * Key/value scratchpad stored in ~/.config/stm.json
 * Used by AI as working memory for current context.
 *
 * Usage:
 *   stm                          List all entries
 *   stm get <key>                Get value
 *   stm set <key> <value>        Set value
 *   stm delete <key>             Delete key
 *   stm clear                    Clear all entries
 *
 * Alarms:
 *   stm alarm <duration> <msg>   Set a reminder (5m, 1h, 30s)
 *   stm alarm list               List pending alarms
 *   stm alarm snooze <id> [dur]  Postpone alarm (default 5m)
 *   stm alarm stop <id>          Dismiss alarm
 *   stm alarm clear              Clear all alarms
 */

import type { CommandHandler } from './shared.js';
import { parseArgs, parseDuration } from './shared.js';
import { loadSTMFull, saveSTMFull, formatAlarmsForPrompt } from '../memory.js';
import type { STMAlarm } from '../memory.js';

export const stm: CommandHandler = async (session, _fs, args, io) => {
    const { positional } = parseArgs(args, {});

    const subcommand = positional[0];

    // Load current STM
    const stmData = await loadSTMFull(session);

    // Handle alarm subcommand
    if (subcommand === 'alarm') {
        return handleAlarm(session, stmData, positional.slice(1), io);
    }

    const key = positional[1];
    const value = positional.slice(2).join(' ');

    switch (subcommand) {
        case undefined:
        case 'list': {
            // List all entries
            const entries = Object.entries(stmData.entries);
            if (entries.length === 0 && stmData.alarms.length === 0) {
                io.stdout.write('(empty)\n');
            } else {
                if (entries.length > 0) {
                    for (const [k, v] of entries) {
                        io.stdout.write(`${k}=${v}\n`);
                    }
                }
                if (stmData.alarms.length > 0) {
                    if (entries.length > 0) io.stdout.write('\n');
                    io.stdout.write('Alarms:\n');
                    const formatted = formatAlarmsForPrompt(stmData.alarms);
                    if (formatted) io.stdout.write(formatted + '\n');
                }
            }
            return 0;
        }

        case 'get': {
            if (!key) {
                io.stderr.write('stm get: missing key\n');
                return 1;
            }
            const val = stmData.entries[key];
            if (val === undefined) {
                return 1; // Not found, silent
            }
            io.stdout.write(`${val}\n`);
            return 0;
        }

        case 'set': {
            if (!key) {
                io.stderr.write('stm set: missing key\n');
                return 1;
            }
            if (!value) {
                io.stderr.write('stm set: missing value\n');
                return 1;
            }
            stmData.entries[key] = value;
            await saveSTMFull(session, stmData);
            return 0;
        }

        case 'delete':
        case 'rm': {
            if (!key) {
                io.stderr.write('stm delete: missing key\n');
                return 1;
            }
            delete stmData.entries[key];
            await saveSTMFull(session, stmData);
            return 0;
        }

        case 'clear': {
            stmData.entries = {};
            await saveSTMFull(session, stmData);
            return 0;
        }

        default:
            io.stderr.write(`stm: unknown subcommand: ${subcommand}\n`);
            io.stderr.write('usage: stm [list|get|set|delete|clear|alarm] [args]\n');
            return 1;
    }
};

/**
 * Handle alarm subcommands
 */
async function handleAlarm(
    session: any,
    stmData: { entries: Record<string, string>; alarms: STMAlarm[] },
    args: string[],
    io: any
): Promise<number> {
    const subcommand = args[0];

    // No subcommand or 'list' - show alarms
    if (!subcommand || subcommand === 'list') {
        if (stmData.alarms.length === 0) {
            io.stdout.write('(no alarms)\n');
        } else {
            const formatted = formatAlarmsForPrompt(stmData.alarms);
            if (formatted) io.stdout.write(formatted + '\n');
        }
        return 0;
    }

    // Clear all alarms
    if (subcommand === 'clear') {
        stmData.alarms = [];
        await saveSTMFull(session, stmData);
        io.stdout.write('All alarms cleared\n');
        return 0;
    }

    // Stop/dismiss an alarm
    if (subcommand === 'stop' || subcommand === 'dismiss') {
        const id = args[1];
        if (!id) {
            io.stderr.write('stm alarm stop: missing alarm id\n');
            return 1;
        }

        const idx = stmData.alarms.findIndex(a => a.id.startsWith(id));
        if (idx === -1) {
            io.stderr.write(`stm alarm stop: alarm not found: ${id}\n`);
            return 1;
        }

        stmData.alarms.splice(idx, 1);
        await saveSTMFull(session, stmData);
        return 0;
    }

    // Snooze an alarm
    if (subcommand === 'snooze') {
        const id = args[1];
        if (!id) {
            io.stderr.write('stm alarm snooze: missing alarm id\n');
            return 1;
        }

        const alarm = stmData.alarms.find(a => a.id.startsWith(id));
        if (!alarm) {
            io.stderr.write(`stm alarm snooze: alarm not found: ${id}\n`);
            return 1;
        }

        // Parse snooze duration (default 5m)
        const durationStr = args[2] || '5m';
        const durationMs = parseDuration(durationStr);
        if (durationMs === null) {
            io.stderr.write(`stm alarm snooze: invalid duration: ${durationStr}\n`);
            return 1;
        }

        // Update due time
        alarm.due = new Date(Date.now() + durationMs).toISOString();
        await saveSTMFull(session, stmData);

        io.stdout.write(`Snoozed for ${durationStr}\n`);
        return 0;
    }

    // Otherwise, treat as: alarm <duration> <message>
    const durationStr = subcommand;
    const message = args.slice(1).join(' ');

    if (!message) {
        io.stderr.write('stm alarm: missing message\n');
        io.stderr.write('usage: stm alarm <duration> <message>\n');
        return 1;
    }

    const durationMs = parseDuration(durationStr);
    if (durationMs === null) {
        io.stderr.write(`stm alarm: invalid duration: ${durationStr}\n`);
        io.stderr.write('examples: 5m, 30s, 1h, 90m\n');
        return 1;
    }

    // Create new alarm
    const alarm: STMAlarm = {
        id: crypto.randomUUID(),
        message,
        due: new Date(Date.now() + durationMs).toISOString(),
        created: new Date().toISOString(),
    };

    stmData.alarms.push(alarm);
    await saveSTMFull(session, stmData);

    io.stdout.write(`Alarm set: ${alarm.id.slice(0, 6)} in ${durationStr}\n`);
    return 0;
}
