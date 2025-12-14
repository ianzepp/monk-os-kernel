/**
 * base64 - Base64 encode or decode data
 *
 * SYNOPSIS
 * ========
 * base64 [OPTIONS] [FILE]
 *
 * DESCRIPTION
 * ===========
 * Base64 encode or decode FILE, or standard input, to standard output.
 * Base64 is a binary-to-text encoding scheme that represents binary data in
 * an ASCII string format using 64 printable characters.
 *
 * With no FILE, or when FILE is -, read standard input.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU coreutils base64
 * Supported flags:
 *   -d, --decode      Decode data
 *   -w, --wrap=COLS   Wrap encoded lines at COLS characters (default 76, 0 = no wrap)
 *   --help            Display help
 * Unsupported:
 *   -i, --ignore-garbage  (data is strictly validated)
 *
 * EXIT CODES
 * ==========
 * 0 - Success
 * 1 - Failure (invalid base64 data when decoding, file errors)
 * 2 - Usage error
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  consumed - reads all input before encoding/decoding
 * stdout: sends item({ text }) - base64 output with optional line wrapping
 * stderr: item({ text }) - error messages in "base64: context: message" format
 *
 * EDGE CASES
 * ==========
 * - Empty input: Produces no output
 * - Invalid base64 when decoding: Error to stderr, exit 1
 * - Binary output when decoding: Written as UTF-8 (may produce replacement chars)
 * - Wrap width 0: No wrapping (single line output)
 *
 * @module rom/bin/base64
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

const DEFAULT_WRAP = 76;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: base64 [OPTIONS] [FILE]

Base64 encode or decode FILE, or standard input, to standard output.
With no FILE, or when FILE is -, read standard input.

Options:
  -d, --decode       Decode data
  -w, --wrap=COLS    Wrap encoded lines at COLS characters (default 76, 0 = no wrap)
  -h, --help         Display this help and exit

Examples:
  echo "hello" | base64              Encode stdin
  base64 file.txt                    Encode file
  echo "aGVsbG8K" | base64 -d        Decode stdin
  base64 -w 0 file.txt               Encode without line wrapping
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    decode: { short: 'd', long: 'decode', desc: 'Decode data' },
    wrap: { short: 'w', long: 'wrap', value: true, desc: 'Wrap width' },
    help: { short: 'h', long: 'help', desc: 'Display help' },
};

// =============================================================================
// ENCODING/DECODING
// =============================================================================

/**
 * Base64 encode bytes with optional line wrapping.
 */
function encodeBase64(data: Uint8Array, wrapWidth: number): string {
    const base64 = btoa(String.fromCharCode(...data));

    if (wrapWidth === 0) {
        return base64;
    }

    const lines: string[] = [];

    for (let i = 0; i < base64.length; i += wrapWidth) {
        lines.push(base64.slice(i, i + wrapWidth));
    }

    return lines.join('\n');
}

/**
 * Base64 decode string to bytes.
 */
function decodeBase64(data: string): Uint8Array {
    // Remove whitespace (newlines, spaces)
    const cleaned = data.replace(/\s/g, '');

    try {
        const decoded = atob(cleaned);
        const bytes = new Uint8Array(decoded.length);

        for (let i = 0; i < decoded.length; i++) {
            bytes[i] = decoded.charCodeAt(i);
        }

        return bytes;
    }
    catch (err) {
        throw new Error('invalid input');
    }
}

// =============================================================================
// FILE PROCESSING
// =============================================================================

/**
 * Process a file for encoding or decoding.
 */
async function processFile(
    path: string,
    decode: boolean,
    wrapWidth: number,
): Promise<void> {
    const fd = await open(path, { read: true });

    try {
        const chunks: Uint8Array[] = [];

        for await (const chunk of read(fd)) {
            chunks.push(chunk);
        }

        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const data = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }

        if (decode) {
            const text = new TextDecoder('utf-8').decode(data);
            const decoded = decodeBase64(text);
            const output = new TextDecoder('utf-8', { fatal: false }).decode(decoded);

            await println(output.endsWith('\n') ? output.slice(0, -1) : output);
        }
        else {
            const encoded = encodeBase64(data, wrapWidth);

            await println(encoded);
        }
    }
    finally {
        await close(fd);
    }
}

/**
 * Process stdin for encoding or decoding.
 */
async function processStdin(decode: boolean, wrapWidth: number): Promise<void> {
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();

    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const text = (msg.data as { text?: string }).text ?? '';

            chunks.push(encoder.encode(text));
        }
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }

    if (decode) {
        const text = new TextDecoder('utf-8').decode(data);
        const decoded = decodeBase64(text);
        const output = new TextDecoder('utf-8', { fatal: false }).decode(decoded);

        await println(output.endsWith('\n') ? output.slice(0, -1) : output);
    }
    else {
        const encoded = encodeBase64(data, wrapWidth);

        await println(encoded);
    }
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`base64: ${err}`);
        }

        await eprintln(`Try 'base64 --help' for more information.`);

        return exit(EXIT_USAGE);
    }

    if (parsed.unknown.length > 0) {
        for (const flag of parsed.unknown) {
            await eprintln(`base64: unknown option: ${flag}`);
        }

        await eprintln(`Try 'base64 --help' for more information.`);

        return exit(EXIT_USAGE);
    }

    if (parsed.flags.help) {
        await println(HELP_TEXT);
        await send(1, respond.done());

        return exit(EXIT_SUCCESS);
    }

    const decode = !!parsed.flags.decode;
    let wrapWidth = DEFAULT_WRAP;

    if (parsed.flags.wrap !== undefined) {
        const w = parseInt(parsed.flags.wrap as string, 10);

        if (isNaN(w) || w < 0) {
            await eprintln('base64: invalid wrap width');

            return exit(EXIT_USAGE);
        }

        wrapWidth = w;
    }

    const files = parsed.positional;

    if (files.length === 0) {
        files.push('-');
    }

    let hadError = false;

    for (const file of files) {
        try {
            if (file === '-') {
                await processStdin(decode, wrapWidth);
            }
            else {
                const cwd = await getcwd();
                const path = resolvePath(cwd, file);

                await processFile(path, decode, wrapWidth);
            }
        }
        catch (err) {
            await eprintln(`base64: ${file}: ${formatError(err)}`);
            hadError = true;
        }
    }

    await send(1, respond.done());

    return exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}
