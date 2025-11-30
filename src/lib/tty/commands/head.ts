/**
 * head - Output the first part of files
 *
 * Usage:
 *   head [-n N] [file]    Show first N lines (default: 10)
 *   <input> | head        Read from stdin
 *
 * Examples:
 *   head /tmp/log.txt
 *   head -n 5 /tmp/log.txt
 *   cat file | head -n 20
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const head: CommandHandler = async (session, fs, args, io) => {
    // Parse -n option
    let lines = 10;
    let file: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-n' && args[i + 1]) {
            const n = parseInt(args[++i], 10);
            if (isNaN(n) || n < 0) {
                io.stderr.write(`head: invalid number of lines: '${args[i]}'\n`);
                return 1;
            }
            lines = n;
        } else if (!arg.startsWith('-')) {
            file = arg;
        }
    }

    // Read from file or stdin
    let content: string;

    if (file) {
        if (!fs) {
            io.stderr.write('head: filesystem not available\n');
            return 1;
        }
        const resolved = resolvePath(session.cwd, file);
        try {
            const data = await fs.read(resolved);
            content = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`head: ${file}: ${err.message}\n`);
                return 1;
            }
            throw err;
        }
    } else {
        // Read from stdin
        let buffer = '';
        for await (const chunk of io.stdin) {
            buffer += chunk.toString();
        }
        content = buffer;
    }

    // Output first N lines
    const allLines = content.split('\n');

    // Remove trailing empty element if content ends with newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
    }

    const output = allLines.slice(0, lines);

    for (const line of output) {
        io.stdout.write(line + '\n');
    }

    return 0;
};
