/**
 * stat - display file status
 *
 * Usage:
 *   stat [options] <file...>
 *
 * Options:
 *   -L              Follow symlinks
 *   -f              Display filesystem info
 *   -c <format>     Use custom format
 *   -t              Terse output (single line)
 *
 * Format sequences:
 *   %n      File name
 *   %N      Quoted file name with symlink target
 *   %s      Size in bytes
 *   %b      Blocks allocated
 *   %f      Raw mode in hex
 *   %a      Access rights in octal
 *   %A      Access rights in human readable
 *   %u      User ID
 *   %U      User name
 *   %g      Group ID
 *   %G      Group name
 *   %t      Device type (major)
 *   %T      Device type (minor)
 *   %h      Number of hard links
 *   %i      Inode number
 *   %F      File type
 *   %X      Access time (epoch)
 *   %x      Access time (human)
 *   %Y      Modification time (epoch)
 *   %y      Modification time (human)
 *   %Z      Change time (epoch)
 *   %z      Change time (human)
 *
 * Examples:
 *   stat file.txt
 *   stat -L symlink
 *   stat -c "%n: %s bytes" *
 *   stat -t *.json
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FSEntry } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs, formatMode } from './shared.js';

const argSpecs = {
    followLinks: { short: 'L', desc: 'Follow symlinks' },
    filesystem: { short: 'f', desc: 'Filesystem info' },
    format: { short: 'c', value: true, desc: 'Custom format' },
    terse: { short: 't', desc: 'Terse output' },
};

type StatOptions = {
    followLinks: boolean;
    filesystem: boolean;
    format: string | null;
    terse: boolean;
};

/**
 * Get file type description
 */
function getFileType(entry: FSEntry): string {
    switch (entry.type) {
        case 'directory':
            return 'directory';
        case 'symlink':
            return 'symbolic link';
        case 'file':
        default:
            return 'regular file';
    }
}

/**
 * Format access rights in octal
 */
function formatOctalMode(mode: number): string {
    return (mode & 0o777).toString(8).padStart(4, '0');
}

/**
 * Format timestamp
 */
function formatTime(date: Date | undefined): { epoch: string; human: string } {
    if (!date) {
        return { epoch: '0', human: '-' };
    }
    return {
        epoch: Math.floor(date.getTime() / 1000).toString(),
        human: date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    };
}

/**
 * Apply format string to entry
 */
function applyFormat(format: string, entry: FSEntry, path: string): string {
    const atime = formatTime(entry.atime);
    const mtime = formatTime(entry.mtime);
    const ctime = formatTime(entry.ctime);

    let result = format;

    // Process format sequences
    result = result.replace(/%N/g, () => {
        if (entry.type === 'symlink' && entry.target) {
            return `'${entry.name}' -> '${entry.target}'`;
        }
        return `'${entry.name}'`;
    });
    result = result.replace(/%n/g, entry.name);
    result = result.replace(/%s/g, String(entry.size));
    result = result.replace(/%b/g, String(Math.ceil(entry.size / 512)));
    result = result.replace(/%f/g, entry.mode.toString(16));
    result = result.replace(/%a/g, formatOctalMode(entry.mode));
    result = result.replace(/%A/g, formatMode(entry.type, entry.mode));
    result = result.replace(/%u/g, '0');
    result = result.replace(/%U/g, 'root');
    result = result.replace(/%g/g, '0');
    result = result.replace(/%G/g, 'root');
    result = result.replace(/%t/g, '0');
    result = result.replace(/%T/g, '0');
    result = result.replace(/%h/g, '1');
    result = result.replace(/%i/g, '0');
    result = result.replace(/%F/g, getFileType(entry));
    result = result.replace(/%X/g, atime.epoch);
    result = result.replace(/%x/g, atime.human);
    result = result.replace(/%Y/g, mtime.epoch);
    result = result.replace(/%y/g, mtime.human);
    result = result.replace(/%Z/g, ctime.epoch);
    result = result.replace(/%z/g, ctime.human);

    // Handle escape sequences
    result = result.replace(/\\n/g, '\n');
    result = result.replace(/\\t/g, '\t');
    result = result.replace(/\\\\/g, '\\');

    return result;
}

/**
 * Format default output
 */
function formatDefault(entry: FSEntry, path: string): string[] {
    const lines: string[] = [];

    // Header line
    if (entry.type === 'symlink' && entry.target) {
        lines.push(`  File: ${entry.name} -> ${entry.target}`);
    } else {
        lines.push(`  File: ${entry.name}`);
    }

    // Size and type
    const blocks = Math.ceil(entry.size / 512);
    lines.push(`  Size: ${entry.size}\t\tBlocks: ${blocks}\t\t${getFileType(entry)}`);

    // Mode and links
    const mode = formatMode(entry.type, entry.mode);
    const octal = formatOctalMode(entry.mode);
    lines.push(`Access: (${octal}/${mode})  Uid: (    0/    root)   Gid: (    0/    root)`);

    // Times
    const atime = formatTime(entry.atime);
    const mtime = formatTime(entry.mtime);
    const ctime = formatTime(entry.ctime);

    lines.push(`Access: ${atime.human}`);
    lines.push(`Modify: ${mtime.human}`);
    lines.push(`Change: ${ctime.human}`);

    return lines;
}

/**
 * Format terse output
 */
function formatTerse(entry: FSEntry, path: string): string {
    const blocks = Math.ceil(entry.size / 512);
    const mtime = entry.mtime ? Math.floor(entry.mtime.getTime() / 1000) : 0;
    const ctime = entry.ctime ? Math.floor(entry.ctime.getTime() / 1000) : 0;
    const atime = entry.atime ? Math.floor(entry.atime.getTime() / 1000) : 0;

    // name size blocks mode uid gid device inode links major minor atime mtime ctime
    return [
        entry.name,
        entry.size,
        blocks,
        entry.mode.toString(16),
        0, // uid
        0, // gid
        0, // device
        0, // inode
        1, // links
        0, // major
        0, // minor
        atime,
        mtime,
        ctime,
    ].join(' ');
}

export const stat: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`stat: ${err}\n`);
        }
        return 1;
    }

    if (parsed.positional.length === 0) {
        io.stderr.write('stat: missing operand\n');
        io.stderr.write('Usage: stat [options] <file...>\n');
        return 1;
    }

    const options: StatOptions = {
        followLinks: Boolean(parsed.flags.followLinks),
        filesystem: Boolean(parsed.flags.filesystem),
        format: typeof parsed.flags.format === 'string' ? parsed.flags.format : null,
        terse: Boolean(parsed.flags.terse),
    };

    let exitCode = 0;

    for (const file of parsed.positional) {
        const resolved = resolvePath(session.cwd, file);

        try {
            const entry = await fs!.stat(resolved);

            // Follow symlinks if requested
            let targetEntry = entry;
            if (options.followLinks && entry.type === 'symlink' && entry.target) {
                try {
                    targetEntry = await fs!.stat(entry.target);
                } catch {
                    // If target doesn't exist, use the symlink itself
                }
            }

            if (options.format) {
                io.stdout.write(applyFormat(options.format, targetEntry, resolved) + '\n');
            } else if (options.terse) {
                io.stdout.write(formatTerse(targetEntry, resolved) + '\n');
            } else {
                const lines = formatDefault(targetEntry, resolved);
                for (const line of lines) {
                    io.stdout.write(line + '\n');
                }
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`stat: cannot stat '${file}': ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    return exitCode;
};
