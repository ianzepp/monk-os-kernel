/**
 * sha256sum - Compute and check SHA256 message digest
 *
 * SYNOPSIS
 * ========
 * sha256sum [OPTIONS] [FILE]...
 *
 * DESCRIPTION
 * ===========
 * Print or check SHA256 (256-bit) checksums.
 * With no FILE, or when FILE is -, read standard input.
 *
 * SHA-256 is a cryptographic hash function from the SHA-2 family that produces
 * a 256-bit hash value, typically expressed as a 64-character hexadecimal number.
 * It is widely used for security applications and data integrity verification.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU coreutils sha256sum
 * Supported flags:
 *   --help            Display help
 * Unsupported:
 *   -b, --binary      (all files treated as binary)
 *   -c, --check       Check SHA256 sums from file
 *   -t, --text        (all files treated as binary)
 *   --tag             BSD-style output format
 *   --quiet           Don't print OK for verified files
 *   --status          Don't output anything
 *   --strict          Exit non-zero for improperly formatted lines
 *   -w, --warn        Warn about improperly formatted lines
 *
 * EXIT CODES
 * ==========
 * 0 - Success
 * 1 - Failure (file read errors)
 * 2 - Usage error
 *
 * OUTPUT FORMAT
 * =============
 * hash  filename
 *
 * The hash is a 64-character hexadecimal string. Two spaces separate the
 * hash from the filename (matches GNU sha256sum format).
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  consumed - reads all input if no files or file is "-"
 * stdout: sends item({ text }) - hash output lines
 * stderr: item({ text }) - error messages in "sha256sum: context: message" format
 *
 * EDGE CASES
 * ==========
 * - Empty file: Produces valid SHA256 hash
 * - Binary files: Hashed as-is (no text conversion)
 * - Missing files: Error to stderr, continue with remaining files
 * - Stdin: Hash displayed with filename "-"
 *
 * @module rom/bin/sha256sum
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    getargs,
    getcwd,
    open,
    read,
    close,
    recv,
    send,
    println,
    eprintln,
    exit,
    respond,
} from '@rom/lib/process/index.js';
import { parseArgs, formatError } from '@rom/lib/args';
import { resolvePath } from '@rom/lib/shell';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: sha256sum [OPTIONS] [FILE]...

Print SHA256 (256-bit) checksums.
With no FILE, or when FILE is -, read standard input.

Options:
  -h, --help         Display this help and exit

Output format:
  hash  filename

The hash is a 64-character hexadecimal string.
Two spaces separate the hash from the filename.

Examples:
  sha256sum file.txt                Hash a single file
  sha256sum file1.txt file2.txt     Hash multiple files
  echo "hello" | sha256sum          Hash stdin
  sha256sum -                       Hash stdin explicitly
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    help: { short: 'h', long: 'help', desc: 'Display help' },
};

// =============================================================================
// HASHING
// =============================================================================

/**
 * Compute SHA-256 hash of file.
 */
async function hashFile(path: string): Promise<string> {
    const fd = await open(path, { read: true });

    try {
        const hasher = new Bun.CryptoHasher('sha256');

        for await (const chunk of read(fd)) {
            hasher.update(chunk);
        }

        return hasher.digest('hex');
    }
    finally {
        await close(fd);
    }
}

/**
 * Compute SHA-256 hash of stdin.
 */
async function hashStdin(): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256');
    const encoder = new TextEncoder();

    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const text = (msg.data as { text?: string }).text ?? '';

            hasher.update(encoder.encode(text));
        }
    }

    return hasher.digest('hex');
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`sha256sum: ${err}`);
        }

        await eprintln(`Try 'sha256sum --help' for more information.`);

        return exit(EXIT_USAGE);
    }

    if (parsed.unknown.length > 0) {
        for (const flag of parsed.unknown) {
            await eprintln(`sha256sum: unknown option: ${flag}`);
        }

        await eprintln(`Try 'sha256sum --help' for more information.`);

        return exit(EXIT_USAGE);
    }

    if (parsed.flags.help) {
        await println(HELP_TEXT);
        await send(1, respond.done());

        return exit(EXIT_SUCCESS);
    }

    const files = parsed.positional;

    if (files.length === 0) {
        files.push('-');
    }

    const cwd = await getcwd();
    let hadError = false;

    for (const file of files) {
        try {
            let hash: string;

            if (file === '-') {
                hash = await hashStdin();
            }
            else {
                const path = resolvePath(cwd, file);

                hash = await hashFile(path);
            }

            await println(`${hash}  ${file}`);
        }
        catch (err) {
            await eprintln(`sha256sum: ${file}: ${formatError(err)}`);
            hadError = true;
        }
    }

    await send(1, respond.done());

    return exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}
