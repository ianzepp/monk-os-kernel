/**
 * base64 - Encode or decode base64 data
 *
 * Usage:
 *   base64 [options] [file]
 *   <input> | base64 [options]
 *
 * Options:
 *   -d, --decode    Decode base64 input
 *   -w N            Wrap lines at N characters (default: 76, 0 = no wrap)
 *
 * Examples:
 *   echo "hello" | base64           Encode text
 *   echo "aGVsbG8K" | base64 -d     Decode base64
 *   base64 /path/to/file            Encode file contents
 *   base64 -d /path/to/encoded      Decode file contents
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const base64: CommandHandler = async (session, fs, args, io) => {
    let decode = false;
    let wrap = 76;
    let file: string | undefined;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-d' || arg === '--decode') {
            decode = true;
        } else if (arg === '-w' && args[i + 1]) {
            wrap = parseInt(args[++i], 10);
            if (isNaN(wrap) || wrap < 0) {
                io.stderr.write(`base64: invalid wrap size: '${args[i]}'\n`);
                return 1;
            }
        } else if (!arg.startsWith('-')) {
            file = arg;
        }
    }

    // Read input
    let input: Buffer;

    if (file) {
        if (!fs) {
            io.stderr.write('base64: filesystem not available\n');
            return 1;
        }
        const resolved = resolvePath(session.cwd, file);
        try {
            const data = await fs.read(resolved);
            input = Buffer.isBuffer(data) ? data : Buffer.from(data);
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`base64: ${file}: ${err.message}\n`);
                return 1;
            }
            throw err;
        }
    } else {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(Buffer.from(chunk));
        }
        input = Buffer.concat(chunks);
    }

    if (decode) {
        // Decode base64
        try {
            // Remove whitespace before decoding
            const cleaned = input.toString().replace(/\s/g, '');
            const decoded = Buffer.from(cleaned, 'base64');
            io.stdout.write(decoded);
        } catch {
            io.stderr.write('base64: invalid input\n');
            return 1;
        }
    } else {
        // Encode to base64
        let encoded = input.toString('base64');

        // Wrap lines if requested
        if (wrap > 0) {
            const lines: string[] = [];
            for (let i = 0; i < encoded.length; i += wrap) {
                lines.push(encoded.slice(i, i + wrap));
            }
            encoded = lines.join('\n');
        }

        io.stdout.write(encoded + '\n');
    }

    return 0;
};
