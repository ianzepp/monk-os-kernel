/**
 * realpath - print resolved absolute path
 *
 * Usage:
 *   realpath [options] <file...>
 *
 * Options:
 *   -e              All path components must exist
 *   -m              No path components need exist
 *   -L              Resolve .. before symlinks (logical)
 *   -P              Resolve symlinks as encountered (physical, default)
 *   -q              Quiet (suppress errors)
 *   -s              No symlink expansion
 *   --relative-to=<dir>     Print path relative to directory
 *   --relative-base=<dir>   Print relative if under base
 *
 * Examples:
 *   realpath .
 *   realpath ../foo/bar
 *   realpath -e /api/data/users/123
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    mustExist: { short: 'e', desc: 'Must exist' },
    mayNotExist: { short: 'm', desc: 'May not exist' },
    logical: { short: 'L', desc: 'Logical resolution' },
    physical: { short: 'P', desc: 'Physical resolution' },
    quiet: { short: 'q', desc: 'Quiet' },
    noSymlinks: { short: 's', desc: 'No symlink expansion' },
    relativeTo: { long: 'relative-to', value: true, desc: 'Relative to dir' },
    relativeBase: { long: 'relative-base', value: true, desc: 'Relative base' },
};

/**
 * Make path relative to base
 */
function makeRelative(path: string, base: string): string {
    // Ensure both paths are absolute and normalized
    const pathParts = path.split('/').filter(p => p);
    const baseParts = base.split('/').filter(p => p);

    // Find common prefix
    let common = 0;
    while (common < pathParts.length && common < baseParts.length) {
        if (pathParts[common] !== baseParts[common]) break;
        common++;
    }

    // Build relative path
    const ups = baseParts.length - common;
    const downs = pathParts.slice(common);

    const parts: string[] = [];
    for (let i = 0; i < ups; i++) {
        parts.push('..');
    }
    parts.push(...downs);

    return parts.join('/') || '.';
}

export const realpath: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`realpath: ${err}\n`);
        }
        return 1;
    }

    if (parsed.positional.length === 0) {
        io.stderr.write('realpath: missing operand\n');
        io.stderr.write('Usage: realpath [options] <file...>\n');
        return 1;
    }

    const mustExist = Boolean(parsed.flags.mustExist);
    const mayNotExist = Boolean(parsed.flags.mayNotExist);
    const noSymlinks = Boolean(parsed.flags.noSymlinks);
    const quiet = Boolean(parsed.flags.quiet);
    const relativeTo = typeof parsed.flags.relativeTo === 'string'
        ? resolvePath(session.cwd, parsed.flags.relativeTo)
        : null;
    const relativeBase = typeof parsed.flags.relativeBase === 'string'
        ? resolvePath(session.cwd, parsed.flags.relativeBase)
        : null;

    let exitCode = 0;

    for (const file of parsed.positional) {
        try {
            let resolved = resolvePath(session.cwd, file);

            // Resolve symlinks unless disabled
            if (!noSymlinks) {
                try {
                    const entry = await fs!.stat(resolved);
                    if (entry.type === 'symlink' && entry.target) {
                        resolved = resolvePath(session.cwd, entry.target);
                    }
                } catch {
                    // Path doesn't exist, that's okay unless mustExist
                    if (mustExist) {
                        throw new FSError('ENOENT', `No such file or directory: ${file}`);
                    }
                }
            }

            // Verify existence if required
            if (mustExist && !mayNotExist) {
                await fs!.stat(resolved);
            }

            // Make relative if requested
            let output = resolved;
            if (relativeTo) {
                output = makeRelative(resolved, relativeTo);
            } else if (relativeBase && resolved.startsWith(relativeBase)) {
                output = makeRelative(resolved, relativeBase);
            }

            io.stdout.write(output + '\n');
        } catch (err) {
            if (err instanceof FSError) {
                if (!quiet) {
                    io.stderr.write(`realpath: ${file}: ${err.message}\n`);
                }
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    return exitCode;
};
