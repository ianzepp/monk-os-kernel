/**
 * du - estimate file space usage
 *
 * Usage:
 *   du [options] [file...]
 *
 * Options:
 *   -a              Show all files, not just directories
 *   -h              Human-readable sizes (1K, 2M, 3G)
 *   -s              Summary only (total for each argument)
 *   -c              Produce a grand total
 *   -d <depth>      Max depth to display
 *   --max-depth=<n> Same as -d
 *   -b              Apparent size in bytes
 *   -k              Size in kilobytes (default)
 *   -m              Size in megabytes
 *
 * Examples:
 *   du                        Current directory
 *   du -sh /api/data          Summary with human sizes
 *   du -ah /tmp               All files, human sizes
 *   du -d 1 /                 One level deep
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FS } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';
import type { CommandIO } from '../types.js';

const argSpecs = {
    all: { short: 'a', desc: 'All files' },
    human: { short: 'h', desc: 'Human readable' },
    summary: { short: 's', desc: 'Summary only' },
    total: { short: 'c', desc: 'Grand total' },
    depth: { short: 'd', value: true, desc: 'Max depth' },
    maxDepth: { long: 'max-depth', value: true, desc: 'Max depth' },
    bytes: { short: 'b', desc: 'Bytes' },
    kilobytes: { short: 'k', desc: 'Kilobytes' },
    megabytes: { short: 'm', desc: 'Megabytes' },
};

type DuOptions = {
    all: boolean;
    human: boolean;
    summary: boolean;
    total: boolean;
    maxDepth: number;
    unit: 'bytes' | 'kilobytes' | 'megabytes';
};

/**
 * Format size based on options
 */
function formatSize(bytes: number, options: DuOptions): string {
    if (options.human) {
        const units = ['', 'K', 'M', 'G', 'T'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        const formatted = unitIndex === 0
            ? String(size)
            : size.toFixed(size < 10 ? 1 : 0);

        return formatted + units[unitIndex];
    }

    switch (options.unit) {
        case 'bytes':
            return String(bytes);
        case 'megabytes':
            return String(Math.ceil(bytes / (1024 * 1024)));
        case 'kilobytes':
        default:
            return String(Math.ceil(bytes / 1024));
    }
}

/**
 * Calculate directory size recursively
 */
async function calculateSize(
    fs: FS,
    path: string,
    options: DuOptions,
    depth: number,
    io: CommandIO,
    results: { path: string; size: number }[]
): Promise<number> {
    if (io.signal?.aborted) return 0;

    try {
        const entry = await fs.stat(path);

        if (entry.type !== 'directory') {
            // File - just return its size
            if (options.all && !options.summary && depth <= options.maxDepth) {
                results.push({ path, size: entry.size });
            }
            return entry.size;
        }

        // Directory - sum children
        const entries = await fs.readdir(path);
        let totalSize = 0;

        for (const child of entries) {
            if (io.signal?.aborted) return totalSize;

            const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`;
            const childSize = await calculateSize(fs, childPath, options, depth + 1, io, results);
            totalSize += childSize;
        }

        // Output this directory if within depth
        if (!options.summary && depth <= options.maxDepth) {
            results.push({ path, size: totalSize });
        }

        return totalSize;
    } catch {
        return 0;
    }
}

export const du: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`du: ${err}\n`);
        }
        return 1;
    }

    // Parse max depth
    let maxDepth = Infinity;
    if (typeof parsed.flags.depth === 'string') {
        maxDepth = parseInt(parsed.flags.depth, 10);
    } else if (typeof parsed.flags.maxDepth === 'string') {
        maxDepth = parseInt(parsed.flags.maxDepth, 10);
    }
    if (parsed.flags.summary) {
        maxDepth = 0;
    }

    // Parse unit
    let unit: 'bytes' | 'kilobytes' | 'megabytes' = 'kilobytes';
    if (parsed.flags.bytes) unit = 'bytes';
    if (parsed.flags.megabytes) unit = 'megabytes';

    const options: DuOptions = {
        all: Boolean(parsed.flags.all),
        human: Boolean(parsed.flags.human),
        summary: Boolean(parsed.flags.summary),
        total: Boolean(parsed.flags.total),
        maxDepth,
        unit,
    };

    const targets = parsed.positional.length > 0
        ? parsed.positional
        : ['.'];

    let grandTotal = 0;
    let exitCode = 0;

    for (const target of targets) {
        if (io.signal?.aborted) return 130;

        const resolved = resolvePath(session.cwd, target);
        const results: { path: string; size: number }[] = [];

        try {
            const size = await calculateSize(fs!, resolved, options, 0, io, results);

            // Output results (reverse to show subdirs before parents)
            for (const result of results) {
                io.stdout.write(`${formatSize(result.size, options)}\t${result.path}\n`);
            }

            // Summary line for this target
            if (options.summary) {
                io.stdout.write(`${formatSize(size, options)}\t${resolved}\n`);
            }

            grandTotal += size;
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`du: ${target}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    // Grand total
    if (options.total && targets.length > 0) {
        io.stdout.write(`${formatSize(grandTotal, options)}\ttotal\n`);
    }

    return exitCode;
};
