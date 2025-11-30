/**
 * tail - Output the last part of files
 *
 * Usage:
 *   tail [-n N] [file]    Show last N lines (default: 10)
 *   <input> | tail        Read from stdin
 *
 * Examples:
 *   tail /tmp/log.txt
 *   tail -n 5 /tmp/log.txt
 *   cat file | tail -n 20
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const tail: CommandHandler = async (session, fs, args, io) => {
    // Parse -n option
    let lines = 10;
    let file: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-n' && args[i + 1]) {
            const n = parseInt(args[++i], 10);
            if (isNaN(n) || n < 0) {
                io.stderr.write(`tail: invalid number of lines: '${args[i]}'\n`);
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
            io.stderr.write('tail: filesystem not available\n');
            return 1;
        }
        const resolved = resolvePath(session.cwd, file);
        try {
            const data = await fs.read(resolved);
            content = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`tail: ${file}: ${err.message}\n`);
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

    // Output last N lines
    const allLines = content.split('\n');

    // Remove trailing empty line if content ends with newline
    if (allLines[allLines.length - 1] === '') {
        allLines.pop();
    }

    const start = Math.max(0, allLines.length - lines);
    const output = allLines.slice(start);

    for (const line of output) {
        io.stdout.write(line + '\n');
    }

    return 0;
};
