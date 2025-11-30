/**
 * uniq - Report or filter out repeated lines
 *
 * Usage:
 *   uniq [-cd] [file]     Filter adjacent duplicate lines
 *   <input> | uniq        Read from stdin
 *
 * Examples:
 *   sort file | uniq
 *   sort file | uniq -c
 *   sort file | uniq -d
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const uniq: CommandHandler = async (session, fs, args, io) => {
    // Parse options
    let count = false;
    let duplicatesOnly = false;
    let file: string | undefined;

    for (const arg of args) {
        if (arg.startsWith('-') && arg !== '-') {
            for (const char of arg.slice(1)) {
                if (char === 'c') count = true;
                else if (char === 'd') duplicatesOnly = true;
            }
        } else {
            file = arg;
        }
    }

    // Read from file or stdin
    let content: string;

    if (file) {
        if (!fs) {
            io.stderr.write('uniq: filesystem not available\n');
            return 1;
        }
        const resolved = resolvePath(session.cwd, file);
        try {
            const data = await fs.read(resolved);
            content = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`uniq: ${file}: ${err.message}\n`);
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

    // Split into lines
    const lines = content.split('\n');

    // Remove trailing empty line if content ends with newline
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }

    // Process lines - uniq filters ADJACENT duplicates
    const results: { line: string; count: number }[] = [];
    let prev: string | null = null;

    for (const line of lines) {
        if (line === prev && results.length > 0) {
            results[results.length - 1].count++;
        } else {
            results.push({ line, count: 1 });
            prev = line;
        }
    }

    // Output
    for (const { line, count: cnt } of results) {
        if (duplicatesOnly && cnt === 1) continue;

        if (count) {
            io.stdout.write(`${String(cnt).padStart(7)} ${line}\n`);
        } else {
            io.stdout.write(line + '\n');
        }
    }

    return 0;
};
