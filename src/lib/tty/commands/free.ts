/**
 * free - Display amount of free and used memory in the system
 *
 * Usage:
 *   free              Show memory in bytes
 *   free -h           Human-readable output
 *   free -b           Show output in bytes
 *   free -k           Show output in kibibytes (default)
 *   free -m           Show output in mebibytes
 *   free -g           Show output in gibibytes
 *   free -t           Show total for RAM
 *
 * Examples:
 *   free -h
 *   free -m
 */

import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

export const free: CommandHandler = async (_session, _fs, args, io) => {
    const { flags } = parseArgs(args, {
        human: { short: 'h', long: 'human' },
        bytes: { short: 'b', long: 'bytes' },
        kibi: { short: 'k', long: 'kibi' },
        mebi: { short: 'm', long: 'mebi' },
        gibi: { short: 'g', long: 'gibi' },
        total: { short: 't', long: 'total' },
    });

    const mem = process.memoryUsage();

    // Node.js memory values
    const heapTotal = mem.heapTotal;
    const heapUsed = mem.heapUsed;
    const heapFree = heapTotal - heapUsed;
    const external = mem.external;
    const rss = mem.rss;

    // Determine unit
    let divisor = 1024; // default kibibytes
    let suffix = '';

    if (flags.bytes) {
        divisor = 1;
        suffix = 'B';
    } else if (flags.kibi) {
        divisor = 1024;
        suffix = 'Ki';
    } else if (flags.mebi) {
        divisor = 1024 * 1024;
        suffix = 'Mi';
    } else if (flags.gibi) {
        divisor = 1024 * 1024 * 1024;
        suffix = 'Gi';
    } else if (flags.human) {
        // Human-readable will format each value individually
        divisor = 0; // special marker
    } else {
        divisor = 1024; // default to kibibytes
    }

    const format = (value: number): string => {
        if (divisor === 0) {
            // Human-readable
            return humanReadable(value);
        }
        return String(Math.floor(value / divisor));
    };

    const pad = (s: string, width: number) => s.padStart(width);

    // Header
    const header = ['', 'total', 'used', 'free'];
    const colWidth = flags.human ? 8 : 12;

    io.stdout.write(header.map(h => pad(h, colWidth)).join('') + '\n');

    // Heap row (like "Mem" in Linux free)
    const heapRow = [
        'Heap:',
        format(heapTotal),
        format(heapUsed),
        format(heapFree),
    ];
    io.stdout.write(heapRow.map(v => pad(v, colWidth)).join('') + '\n');

    // External memory (like "Swap" concept)
    const extRow = [
        'External:',
        format(external),
        format(external),
        format(0),
    ];
    io.stdout.write(extRow.map(v => pad(v, colWidth)).join('') + '\n');

    // RSS (total process memory)
    const rssRow = [
        'RSS:',
        format(rss),
        format(rss),
        format(0),
    ];
    io.stdout.write(rssRow.map(v => pad(v, colWidth)).join('') + '\n');

    // Total row if requested
    if (flags.total) {
        const totalMem = heapTotal + external;
        const totalUsed = heapUsed + external;
        const totalFree = heapFree;
        const totalRow = [
            'Total:',
            format(totalMem),
            format(totalUsed),
            format(totalFree),
        ];
        io.stdout.write(totalRow.map(v => pad(v, colWidth)).join('') + '\n');
    }

    return 0;
};

/**
 * Format bytes as human-readable string
 */
function humanReadable(bytes: number): string {
    const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    if (unitIndex === 0) {
        return `${value}${units[unitIndex]}`;
    }

    return `${value.toFixed(1)}${units[unitIndex]}`;
}
