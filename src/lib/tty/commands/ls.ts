/**
 * ls - List directory contents
 *
 * Usage:
 *   ls [options] [path...]
 *
 * Options:
 *   -l        Long format (permissions, size, date)
 *   -a        Show hidden files (starting with .)
 *   -1        One entry per line
 *   -h        Human-readable sizes (1K, 2M, 3G)
 *   -R        Recursive listing
 *   -S        Sort by size (largest first)
 *   -t        Sort by modification time (newest first)
 *   -r        Reverse sort order
 *   -d        List directories themselves, not contents
 *
 * Examples:
 *   ls                    List current directory
 *   ls -la                Long format with hidden files
 *   ls -lhS               Long format, human sizes, sorted by size
 *   ls -R /api/data       Recursive listing
 *   ls -1 *.txt           One per line, glob pattern
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FS, FSEntry } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs, formatMode } from './shared.js';
import type { CommandIO } from '../types.js';

const argSpecs = {
    long: { short: 'l', desc: 'Long format' },
    all: { short: 'a', desc: 'Show hidden files' },
    one: { short: '1', desc: 'One entry per line' },
    human: { short: 'h', desc: 'Human-readable sizes' },
    recursive: { short: 'R', desc: 'Recursive listing' },
    sizeSort: { short: 'S', desc: 'Sort by size' },
    timeSort: { short: 't', desc: 'Sort by time' },
    reverse: { short: 'r', desc: 'Reverse sort' },
    directory: { short: 'd', desc: 'List directories themselves' },
};

type LsOptions = {
    long: boolean;
    all: boolean;
    one: boolean;
    human: boolean;
    recursive: boolean;
    sizeSort: boolean;
    timeSort: boolean;
    reverse: boolean;
    directory: boolean;
};

/**
 * Format size in human-readable form
 */
function formatSize(bytes: number, human: boolean): string {
    if (!human) {
        return String(bytes).padStart(8);
    }

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

    return (formatted + units[unitIndex]).padStart(6);
}

/**
 * Format a single entry for output
 */
function formatEntry(entry: FSEntry, options: LsOptions): string {
    const suffix = entry.type === 'directory' ? '/' : '';

    if (!options.long) {
        return entry.name + suffix;
    }

    const mode = formatMode(entry.type, entry.mode);
    const size = formatSize(entry.size, options.human);
    const date = entry.mtime
        ? entry.mtime.toISOString().slice(0, 10)
        : '          ';

    return `${mode}  ${size}  ${date}  ${entry.name}${suffix}`;
}

/**
 * Sort entries based on options
 */
function sortEntries(entries: FSEntry[], options: LsOptions): FSEntry[] {
    const sorted = [...entries];

    if (options.sizeSort) {
        sorted.sort((a, b) => b.size - a.size);
    } else if (options.timeSort) {
        sorted.sort((a, b) => {
            const timeA = a.mtime?.getTime() ?? 0;
            const timeB = b.mtime?.getTime() ?? 0;
            return timeB - timeA;
        });
    } else {
        // Default: directories first, then alphabetically
        sorted.sort((a, b) => {
            if (a.type === 'directory' && b.type !== 'directory') return -1;
            if (a.type !== 'directory' && b.type === 'directory') return 1;
            return a.name.localeCompare(b.name);
        });
    }

    if (options.reverse) {
        sorted.reverse();
    }

    return sorted;
}

/**
 * List a single directory
 */
async function listDirectory(
    fs: FS,
    path: string,
    options: LsOptions,
    io: CommandIO,
    showPath: boolean
): Promise<number> {
    try {
        const stat = await fs.stat(path);

        // -d flag: list directory itself, not contents
        if (options.directory || stat.type !== 'directory') {
            io.stdout.write(formatEntry(stat, options) + '\n');
            return 0;
        }

        if (showPath) {
            io.stdout.write(`${path}:\n`);
        }

        const entries = await fs.readdir(path);
        const filtered = options.all
            ? entries
            : entries.filter(e => !e.name.startsWith('.'));
        const sorted = sortEntries(filtered, options);

        if (options.long) {
            io.stdout.write(`total ${sorted.length}\n`);
        }

        if (options.long || options.one) {
            for (const entry of sorted) {
                io.stdout.write(formatEntry(entry, options) + '\n');
            }
        } else {
            const names = sorted.map(e => e.name + (e.type === 'directory' ? '/' : ''));
            io.stdout.write(names.join('  ') + '\n');
        }

        // Recursive: list subdirectories
        if (options.recursive) {
            for (const entry of sorted) {
                if (io.signal?.aborted) return 130;
                if (entry.type === 'directory') {
                    io.stdout.write('\n');
                    const subpath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
                    await listDirectory(fs, subpath, options, io, true);
                }
            }
        }

        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`ls: ${path}: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
}

export const ls: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`ls: ${err}\n`);
        }
        return 1;
    }

    const options: LsOptions = {
        long: Boolean(parsed.flags.long),
        all: Boolean(parsed.flags.all),
        one: Boolean(parsed.flags.one),
        human: Boolean(parsed.flags.human),
        recursive: Boolean(parsed.flags.recursive),
        sizeSort: Boolean(parsed.flags.sizeSort),
        timeSort: Boolean(parsed.flags.timeSort),
        reverse: Boolean(parsed.flags.reverse),
        directory: Boolean(parsed.flags.directory),
    };

    const targets = parsed.positional.length > 0
        ? parsed.positional
        : [session.cwd];

    const showPaths = targets.length > 1 || options.recursive;
    let exitCode = 0;

    for (let i = 0; i < targets.length; i++) {
        if (io.signal?.aborted) return 130;

        const resolved = resolvePath(session.cwd, targets[i]);
        const code = await listDirectory(fs!, resolved, options, io, showPaths);

        if (code !== 0) exitCode = code;

        if (i < targets.length - 1) {
            io.stdout.write('\n');
        }
    }

    return exitCode;
};
