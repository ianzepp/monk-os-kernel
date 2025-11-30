/**
 * wc - Word, line, and byte count
 *
 * Usage:
 *   wc [-lwc] [file]      Count lines, words, characters
 *   <input> | wc          Read from stdin
 *
 * Examples:
 *   wc /tmp/file.txt
 *   wc -l /tmp/file.txt
 *   find . | wc -l
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const wc: CommandHandler = async (session, fs, args, io) => {
    // Parse options
    let showLines = false;
    let showWords = false;
    let showChars = false;
    let file: string | undefined;

    for (const arg of args) {
        if (arg.startsWith('-') && arg !== '-') {
            for (const char of arg.slice(1)) {
                if (char === 'l') showLines = true;
                else if (char === 'w') showWords = true;
                else if (char === 'c') showChars = true;
            }
        } else {
            file = arg;
        }
    }

    // Default: show all
    if (!showLines && !showWords && !showChars) {
        showLines = showWords = showChars = true;
    }

    // Read from file or stdin
    let content: string;

    if (file) {
        if (!fs) {
            io.stderr.write('wc: filesystem not available\n');
            return 1;
        }
        const resolved = resolvePath(session.cwd, file);
        try {
            const data = await fs.read(resolved);
            content = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`wc: ${file}: ${err.message}\n`);
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

    // Count
    const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const chars = content.length;

    // Build output
    const parts: string[] = [];
    if (showLines) parts.push(String(lines).padStart(8));
    if (showWords) parts.push(String(words).padStart(8));
    if (showChars) parts.push(String(chars).padStart(8));
    if (file) parts.push(` ${file}`);

    io.stdout.write(parts.join('') + '\n');

    return 0;
};
