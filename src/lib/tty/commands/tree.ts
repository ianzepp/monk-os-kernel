/**
 * tree - Display directory tree
 *
 * Usage:
 *   tree [path]          Show directory tree
 *   tree -L <depth>      Limit depth
 *   tree -d              Directories only
 *
 * Examples:
 *   tree
 *   tree /api
 *   tree -L 2 /api/data
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FS } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import type { CommandIO } from '../types.js';

export const tree: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('tree: filesystem not available\n');
        return 1;
    }

    // Parse options
    let maxDepth = Infinity;
    let dirsOnly = false;
    let target = '.';

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-L' && args[i + 1]) {
            const depth = parseInt(args[++i], 10);
            if (isNaN(depth) || depth < 1) {
                io.stderr.write(`tree: invalid level: ${args[i]}\n`);
                return 1;
            }
            maxDepth = depth;
        } else if (arg === '-d') {
            dirsOnly = true;
        } else if (!arg.startsWith('-')) {
            target = arg;
        }
    }

    const resolved = resolvePath(session.cwd, target);

    try {
        const stats = { dirs: 0, files: 0 };

        // Print root
        io.stdout.write(resolved + '\n');

        await printTree(fs, resolved, '', maxDepth, 0, dirsOnly, io, stats);

        // Print summary
        const dirLabel = stats.dirs === 1 ? 'directory' : 'directories';
        const fileLabel = stats.files === 1 ? 'file' : 'files';
        if (dirsOnly) {
            io.stdout.write(`\n${stats.dirs} ${dirLabel}\n`);
        } else {
            io.stdout.write(`\n${stats.dirs} ${dirLabel}, ${stats.files} ${fileLabel}\n`);
        }

        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`tree: ${target}: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
};

/**
 * Recursively print directory tree
 */
async function printTree(
    fs: FS,
    path: string,
    prefix: string,
    maxDepth: number,
    currentDepth: number,
    dirsOnly: boolean,
    io: CommandIO,
    stats: { dirs: number; files: number }
): Promise<void> {
    if (currentDepth >= maxDepth) {
        return;
    }

    let entries;
    try {
        entries = await fs.readdir(path);
    } catch {
        return; // Can't read directory
    }

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
    });

    // Filter if dirsOnly
    if (dirsOnly) {
        entries = entries.filter(e => e.type === 'directory');
    }

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const childPrefix = isLast ? '    ' : '│   ';

        // Print entry
        const suffix = entry.type === 'directory' ? '/' : '';
        io.stdout.write(prefix + connector + entry.name + suffix + '\n');

        // Update stats
        if (entry.type === 'directory') {
            stats.dirs++;
            // Recurse
            const childPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
            await printTree(
                fs,
                childPath,
                prefix + childPrefix,
                maxDepth,
                currentDepth + 1,
                dirsOnly,
                io,
                stats
            );
        } else {
            stats.files++;
        }
    }
}
