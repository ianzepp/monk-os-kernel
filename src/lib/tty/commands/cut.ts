/**
 * cut - Remove sections from each line
 *
 * Usage:
 *   cut -d<delim> -f<fields> [file]    Extract fields by delimiter
 *   cut -c<chars> [file]               Extract characters by position
 *
 * Examples:
 *   echo "a,b,c" | cut -d, -f2
 *   cat /etc/passwd | cut -d: -f1,3
 *   cat file | cut -c1-10
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const cut: CommandHandler = async (session, fs, args, io) => {
    // Parse options
    let delimiter = '\t';
    let fields: number[] = [];
    let chars: { start: number; end: number }[] = [];
    let file: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('-d')) {
            // Delimiter: -d, or -d ,
            delimiter = arg.length > 2 ? arg.slice(2) : (args[++i] || '\t');
        } else if (arg.startsWith('-f')) {
            // Fields: -f1,2,3 or -f 1,2,3
            const fieldStr = arg.length > 2 ? arg.slice(2) : args[++i];
            if (fieldStr) {
                fields = parseRanges(fieldStr);
            }
        } else if (arg.startsWith('-c')) {
            // Characters: -c1-10 or -c 1-10
            const charStr = arg.length > 2 ? arg.slice(2) : args[++i];
            if (charStr) {
                chars = parseCharRanges(charStr);
            }
        } else if (!arg.startsWith('-')) {
            file = arg;
        }
    }

    if (fields.length === 0 && chars.length === 0) {
        io.stderr.write('cut: you must specify -f or -c\n');
        io.stderr.write('Usage: cut -d<delim> -f<fields> [file]\n');
        io.stderr.write('       cut -c<chars> [file]\n');
        return 1;
    }

    // Read from file or stdin
    let content: string;

    if (file) {
        if (!fs) {
            io.stderr.write('cut: filesystem not available\n');
            return 1;
        }
        const resolved = resolvePath(session.cwd, file);
        try {
            const data = await fs.read(resolved);
            content = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`cut: ${file}: ${err.message}\n`);
                return 1;
            }
            throw err;
        }
    } else {
        let buffer = '';
        for await (const chunk of io.stdin) {
            buffer += chunk.toString();
        }
        content = buffer;
    }

    // Process lines
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }

    for (const line of lines) {
        let output: string;

        if (chars.length > 0) {
            // Character mode
            output = extractChars(line, chars);
        } else {
            // Field mode
            output = extractFields(line, delimiter, fields);
        }

        io.stdout.write(output + '\n');
    }

    return 0;
};

/**
 * Parse field ranges like "1,3,5" or "1-3,5"
 */
function parseRanges(str: string): number[] {
    const result: number[] = [];

    for (const part of str.split(',')) {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(n => parseInt(n, 10));
            for (let i = start; i <= end; i++) {
                result.push(i);
            }
        } else {
            result.push(parseInt(part, 10));
        }
    }

    return result.filter(n => !isNaN(n) && n > 0);
}

/**
 * Parse character ranges like "1-10" or "1,5,10"
 */
function parseCharRanges(str: string): { start: number; end: number }[] {
    const result: { start: number; end: number }[] = [];

    for (const part of str.split(',')) {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(n => parseInt(n, 10));
            result.push({ start: start - 1, end: end }); // Convert to 0-indexed
        } else {
            const n = parseInt(part, 10);
            result.push({ start: n - 1, end: n });
        }
    }

    return result.filter(r => !isNaN(r.start) && !isNaN(r.end));
}

/**
 * Extract characters from line
 */
function extractChars(line: string, ranges: { start: number; end: number }[]): string {
    let result = '';
    for (const range of ranges) {
        result += line.slice(range.start, range.end);
    }
    return result;
}

/**
 * Extract fields from line
 */
function extractFields(line: string, delimiter: string, fields: number[]): string {
    const parts = line.split(delimiter);
    const selected: string[] = [];

    for (const f of fields) {
        if (parts[f - 1] !== undefined) {
            selected.push(parts[f - 1]);
        }
    }

    return selected.join(delimiter);
}
