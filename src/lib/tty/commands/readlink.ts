/**
 * readlink - print resolved symbolic links or canonical file names
 *
 * Usage:
 *   readlink [options] <file...>
 *
 * Options:
 *   -f              Canonicalize (follow all symlinks, resolve path)
 *   -e              Like -f, but fail if path doesn't exist
 *   -m              Like -f, but don't require path to exist
 *   -n              No trailing newline
 *   -q              Quiet (suppress errors)
 *   -v              Verbose
 *
 * Examples:
 *   readlink /link
 *   readlink -f /path/to/link
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    canonicalize: { short: 'f', desc: 'Canonicalize path' },
    canonicalizeExisting: { short: 'e', desc: 'Canonicalize, must exist' },
    canonicalizeMissing: { short: 'm', desc: 'Canonicalize, may not exist' },
    noNewline: { short: 'n', desc: 'No newline' },
    quiet: { short: 'q', desc: 'Quiet' },
    verbose: { short: 'v', desc: 'Verbose' },
};

export const readlink: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`readlink: ${err}\n`);
        }
        return 1;
    }

    if (parsed.positional.length === 0) {
        io.stderr.write('readlink: missing operand\n');
        io.stderr.write('Usage: readlink [options] <file...>\n');
        return 1;
    }

    const canonicalize = Boolean(
        parsed.flags.canonicalize ||
        parsed.flags.canonicalizeExisting ||
        parsed.flags.canonicalizeMissing
    );
    const mustExist = Boolean(parsed.flags.canonicalizeExisting);
    const noNewline = Boolean(parsed.flags.noNewline);
    const quiet = Boolean(parsed.flags.quiet);

    let exitCode = 0;

    for (let i = 0; i < parsed.positional.length; i++) {
        const file = parsed.positional[i];
        const resolved = resolvePath(session.cwd, file);

        try {
            const entry = await fs!.stat(resolved);

            if (canonicalize) {
                // Return the fully resolved path
                let target = resolved;

                // If it's a symlink, resolve it
                if (entry.type === 'symlink' && entry.target) {
                    target = resolvePath(session.cwd, entry.target);

                    // Verify target exists if required
                    if (mustExist) {
                        await fs!.stat(target);
                    }
                }

                const nl = noNewline && i === parsed.positional.length - 1 ? '' : '\n';
                io.stdout.write(target + nl);
            } else {
                // Just print symlink target
                if (entry.type !== 'symlink') {
                    if (!quiet) {
                        io.stderr.write(`readlink: ${file}: not a symbolic link\n`);
                    }
                    exitCode = 1;
                    continue;
                }

                const nl = noNewline && i === parsed.positional.length - 1 ? '' : '\n';
                io.stdout.write((entry.target || '') + nl);
            }
        } catch (err) {
            if (err instanceof FSError) {
                if (!quiet) {
                    io.stderr.write(`readlink: ${file}: ${err.message}\n`);
                }
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    return exitCode;
};
