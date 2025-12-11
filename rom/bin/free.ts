/**
 * free - Display memory usage
 *
 * SYNOPSIS
 * ========
 * free [-h|--human] [-b|-k|-m|-g]
 *
 * DESCRIPTION
 * ===========
 * Display the amount of free and used memory in the system. In Monk OS,
 * this reports Bun's heap usage since the OS runs as a Bun process.
 *
 * @module rom/bin/free
 */

import { println, exit, getargs } from '@rom/lib/process/index.js';

const HELP_TEXT = `
Usage: free [OPTIONS]

Display memory usage information.

Options:
  -b          Show output in bytes
  -k          Show output in kilobytes (default)
  -m          Show output in megabytes
  -g          Show output in gigabytes
  -h, --human Show human-readable output
  --help      Display this help and exit

Note: Shows Bun process memory (Monk OS runs as a Bun process).
`.trim();

type Unit = 'b' | 'k' | 'm' | 'g';

function formatBytes(bytes: number, unit: Unit, human: boolean): string {
    if (human) {
        if (bytes >= 1024 * 1024 * 1024) {
            return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
        }

        if (bytes >= 1024 * 1024) {
            return (bytes / (1024 * 1024)).toFixed(1) + 'M';
        }

        if (bytes >= 1024) {
            return (bytes / 1024).toFixed(1) + 'K';
        }

        return bytes + 'B';
    }

    switch (unit) {
        case 'b': return bytes.toString();
        case 'k': return Math.floor(bytes / 1024).toString();
        case 'm': return Math.floor(bytes / (1024 * 1024)).toString();
        case 'g': return (bytes / (1024 * 1024 * 1024)).toFixed(2);
    }
}

function padLeft(str: string, width: number): string {
    return str.padStart(width);
}

export default async function main(): Promise<void> {
    const args = await getargs();
    let unit: Unit = 'k';
    let human = false;

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--help':
                await println(HELP_TEXT);

                return exit(0);
            case '-b':
                unit = 'b';
                break;
            case '-k':
                unit = 'k';
                break;
            case '-m':
                unit = 'm';
                break;
            case '-g':
                unit = 'g';
                break;
            case '-h':
            case '--human':
                human = true;
                break;
        }
    }

    // Get memory info from Bun
    const heapStats = process.memoryUsage();
    const total = heapStats.heapTotal;
    const used = heapStats.heapUsed;
    const free = total - used;
    const external = heapStats.external;
    const rss = heapStats.rss;

    // Format values
    const w = 12; // column width
    const totalStr = padLeft(formatBytes(total, unit, human), w);
    const usedStr = padLeft(formatBytes(used, unit, human), w);
    const freeStr = padLeft(formatBytes(free, unit, human), w);
    const rssStr = padLeft(formatBytes(rss, unit, human), w);
    const extStr = padLeft(formatBytes(external, unit, human), w);

    // Output header
    const unitLabel = human ? '' : unit === 'b' ? ' (bytes)' : ` (${unit}i)`;

    await println(`              total        used        free`);
    await println(`Heap:   ${totalStr}${usedStr}${freeStr}`);
    await println(`RSS:    ${rssStr}`);
    await println(`Extern: ${extStr}`);

    return exit(0);
}
