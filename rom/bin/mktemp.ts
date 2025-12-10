/**
 * mktemp - Create temporary file or directory
 *
 * SYNOPSIS
 * ========
 * mktemp [OPTIONS] [TEMPLATE]
 *
 * DESCRIPTION
 * ===========
 * Create a temporary file or directory and print its path to stdout. The TEMPLATE
 * must contain at least 3 consecutive 'X' characters at the end, which are replaced
 * with random alphanumeric characters. If no TEMPLATE is provided, uses tmp.XXXXXXXXXX.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU coreutils mktemp
 * Supported flags:
 *   -d, --directory       Create directory instead of file
 *   -p DIR, --tmpdir=DIR  Use DIR as prefix for template (default /tmp)
 *   -t                    Interpret TEMPLATE relative to tmpdir
 *   -u, --dry-run         Print name only, don't create file/directory
 *   -q, --quiet           Suppress error messages
 *   --help                Display help
 * Unsupported:
 *   --suffix              Add suffix to template (uncommon)
 *
 * EXIT CODES
 * ==========
 * 0 - Success
 * 1 - Failure
 *
 * EXAMPLES
 * ========
 * mktemp                      # /tmp/tmp.a1b2c3d4e5
 * mktemp -d                   # /tmp/tmp.x9y8z7w6v5 (directory)
 * mktemp /tmp/foo.XXXXXX      # /tmp/foo.q2w3e4
 * mktemp -p /var/tmp          # /var/tmp/tmp.r5t6y7u8i9o0
 * mktemp -t foo.XXXXXX        # /tmp/foo.a1b2c3
 * mktemp -u                   # /tmp/tmp.x7y8z9 (not created)
 *
 * @module rom/bin/mktemp
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    getargs,
    getcwd,
    stat,
    mkdir,
    open,
    close,
    println,
    eprintln,
    exit,
    send,
    respond,
} from '@rom/lib/process/index.js';
import { parseArgs, formatError } from '@rom/lib/args';
import { resolvePath } from '@rom/lib/shell';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

const DEFAULT_TEMPLATE = 'tmp.XXXXXXXXXX';
const DEFAULT_TMPDIR = '/tmp';

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: mktemp [OPTIONS] [TEMPLATE]

Create a temporary file or directory and print its path.

Options:
  -d, --directory       Create directory instead of file
  -p DIR, --tmpdir=DIR  Use DIR as prefix (default /tmp)
  -t                    Interpret TEMPLATE relative to tmpdir
  -u, --dry-run         Print name only, don't create
  -q, --quiet           Suppress error messages
  --help                Display this help and exit

Template:
  Must contain at least 3 consecutive X's at the end.
  Default: tmp.XXXXXXXXXX

Examples:
  mktemp                    Create temporary file in /tmp
  mktemp -d                 Create temporary directory in /tmp
  mktemp /tmp/foo.XXXXXX    Create temp file with custom template
  mktemp -p /var/tmp        Use /var/tmp as prefix
  mktemp -t foo.XXXXXX      Use template relative to tmpdir
`.trim();

// =============================================================================
// ARG SPECS
// =============================================================================

const ARG_SPECS = {
    help: { short: 'h', long: 'help' },
    directory: { short: 'd', long: 'directory' },
    tmpdir: { short: 'p', long: 'tmpdir', value: true },
    t: { short: 't' },
    dryRun: { short: 'u', long: 'dry-run' },
    quiet: { short: 'q', long: 'quiet' },
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate random alphanumeric string of specified length.
 */
function randomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Validate template has at least 3 consecutive X's at the end.
 * Returns the number of X's found, or -1 if invalid.
 */
function validateTemplate(template: string): number {
    const match = template.match(/X+$/);
    if (!match || match[0].length < 3) {
        return -1;
    }
    return match[0].length;
}

/**
 * Replace trailing X's with random characters.
 */
function fillTemplate(template: string, xCount: number): string {
    const prefix = template.slice(0, -xCount);
    const suffix = randomString(xCount);
    return prefix + suffix;
}

/**
 * Check if path exists.
 */
async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    if (parsed.flags.help) {
        await println(HELP_TEXT);
        await send(1, respond.done());
        return exit(EXIT_SUCCESS);
    }

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`mktemp: ${err}`);
        }
        await send(1, respond.done());
        return exit(EXIT_FAILURE);
    }

    const isDirectory = Boolean(parsed.flags.directory);
    const isDryRun = Boolean(parsed.flags.dryRun);
    const isQuiet = Boolean(parsed.flags.quiet);
    const useTmpdir = Boolean(parsed.flags.t);
    const tmpdir = (parsed.flags.tmpdir as string | undefined) ?? DEFAULT_TMPDIR;

    let template = parsed.positional[0] ?? DEFAULT_TEMPLATE;

    // If -t flag is used, prepend tmpdir to template
    if (useTmpdir) {
        template = `${tmpdir}/${template}`;
    }
    // If template doesn't start with /, and no -t flag, but tmpdir was specified via -p,
    // prepend tmpdir
    else if (!template.startsWith('/') && parsed.flags.tmpdir) {
        template = `${tmpdir}/${template}`;
    }
    // If template is relative and no tmpdir specified, use default tmpdir
    else if (!template.startsWith('/')) {
        template = `${DEFAULT_TMPDIR}/${template}`;
    }

    // Validate template
    const xCount = validateTemplate(template);
    if (xCount === -1) {
        if (!isQuiet) {
            await eprintln('mktemp: too few X\'s in template');
        }
        await send(1, respond.done());
        return exit(EXIT_FAILURE);
    }

    const cwd = await getcwd();

    // Try to create unique path (max 10000 attempts to avoid infinite loop)
    const maxAttempts = 10000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const path = resolvePath(cwd, fillTemplate(template, xCount));

        // Check if path already exists
        if (await pathExists(path)) {
            continue;
        }

        // Print path to stdout
        await println(path);

        // Create file or directory unless dry-run
        if (!isDryRun) {
            try {
                if (isDirectory) {
                    await mkdir(path);
                }
                else {
                    const fd = await open(path, { write: true, create: true });
                    await close(fd);
                }
            }
            catch (err) {
                if (!isQuiet) {
                    await eprintln(`mktemp: cannot create ${isDirectory ? 'directory' : 'file'}: ${formatError(err)}`);
                }
                await send(1, respond.done());
                return exit(EXIT_FAILURE);
            }
        }

        await send(1, respond.done());
        return exit(EXIT_SUCCESS);
    }

    // Failed to find unique name after max attempts
    if (!isQuiet) {
        await eprintln('mktemp: failed to create unique name');
    }
    await send(1, respond.done());
    return exit(EXIT_FAILURE);
}
