/**
 * mktemp - create a temporary file or directory
 *
 * Usage:
 *   mktemp [options] [template]
 *
 * Options:
 *   -d              Create a directory instead of a file
 *   -u              Dry run (print name, don't create)
 *   -q              Quiet (suppress errors)
 *   -p <dir>        Use dir as prefix (default: /tmp)
 *   -t              Interpret template relative to prefix
 *   --suffix=<suf>  Append suffix to template
 *
 * Template:
 *   Must contain at least 3 consecutive X's, which are
 *   replaced with random characters. Default: tmp.XXXXXXXXXX
 *
 * Examples:
 *   mktemp                    Create /tmp/tmp.XXXXXXXXXX
 *   mktemp -d                 Create temp directory
 *   mktemp myfile.XXXX        Create with custom template
 *   mktemp -p /home/user      Create in specific directory
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    directory: { short: 'd', desc: 'Create directory' },
    dryRun: { short: 'u', desc: 'Dry run' },
    quiet: { short: 'q', desc: 'Quiet' },
    prefix: { short: 'p', value: true, desc: 'Directory prefix' },
    usePrefix: { short: 't', desc: 'Use prefix' },
    suffix: { long: 'suffix', value: true, desc: 'Suffix' },
};

/**
 * Generate random characters
 */
function randomChars(count: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < count; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

/**
 * Apply template substitution
 */
function applyTemplate(template: string): string {
    // Replace consecutive X's with random chars
    return template.replace(/X{3,}/g, match => randomChars(match.length));
}

export const mktemp: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`mktemp: ${err}\n`);
        }
        return 1;
    }

    const isDirectory = Boolean(parsed.flags.directory);
    const dryRun = Boolean(parsed.flags.dryRun);
    const quiet = Boolean(parsed.flags.quiet);
    const prefix = typeof parsed.flags.prefix === 'string'
        ? parsed.flags.prefix
        : '/tmp';
    const usePrefix = Boolean(parsed.flags.usePrefix);
    const suffix = typeof parsed.flags.suffix === 'string'
        ? parsed.flags.suffix
        : '';

    // Get template
    let template = parsed.positional[0] || 'tmp.XXXXXXXXXX';

    // Validate template has XXX
    if (!/X{3,}/.test(template)) {
        if (!quiet) {
            io.stderr.write('mktemp: template must contain at least 3 consecutive X\'s\n');
        }
        return 1;
    }

    // Build full path
    let basePath: string;
    if (usePrefix || !template.includes('/')) {
        basePath = prefix;
    } else {
        basePath = session.cwd;
    }

    // Apply template and suffix
    const name = applyTemplate(template) + suffix;
    const fullPath = resolvePath(basePath, name);

    // Dry run - just print
    if (dryRun) {
        io.stdout.write(fullPath + '\n');
        return 0;
    }

    try {
        // Ensure parent directory exists
        const parentPath = fullPath.substring(0, fullPath.lastIndexOf('/')) || '/';
        try {
            await fs!.stat(parentPath);
        } catch {
            // Try to create parent
            await fs!.mkdir(parentPath);
        }

        if (isDirectory) {
            await fs!.mkdir(fullPath);
        } else {
            await fs!.write(fullPath, Buffer.from(''));
        }

        io.stdout.write(fullPath + '\n');
        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            if (!quiet) {
                io.stderr.write(`mktemp: failed to create ${isDirectory ? 'directory' : 'file'}: ${err.message}\n`);
            }
            return 1;
        }
        throw err;
    }
};
