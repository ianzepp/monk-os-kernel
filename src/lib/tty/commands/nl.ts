/**
 * nl - Number lines of files
 *
 * Usage:
 *   nl [options] [file]
 *   <input> | nl [options]
 *
 * Options:
 *   -b a            Number all lines (default)
 *   -b t            Number non-empty lines only
 *   -b n            No line numbering
 *   -n ln           Left-justified numbers
 *   -n rn           Right-justified numbers (default)
 *   -n rz           Right-justified with leading zeros
 *   -w N            Number width (default: 6)
 *   -s SEP          Separator after number (default: tab)
 *   -v N            Starting line number (default: 1)
 *   -i N            Line number increment (default: 1)
 *
 * Examples:
 *   nl file.txt                     Number all lines
 *   nl -b t file.txt                Number non-empty lines
 *   nl -n rz -w 4 file.txt          Zero-padded 4-digit numbers
 *   cat file.txt | nl -s ": "       Custom separator
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

type BodyNumbering = 'a' | 't' | 'n';
type NumberFormat = 'ln' | 'rn' | 'rz';

export const nl: CommandHandler = async (session, fs, args, io) => {
    let bodyNumbering: BodyNumbering = 'a';
    let numberFormat: NumberFormat = 'rn';
    let width = 6;
    let separator = '\t';
    let startNum = 1;
    let increment = 1;
    let file: string | undefined;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '-b' && args[i + 1]) {
            const val = args[++i];
            if (val === 'a' || val === 't' || val === 'n') {
                bodyNumbering = val;
            } else {
                io.stderr.write(`nl: invalid body numbering style: '${val}'\n`);
                return 1;
            }
        } else if (arg === '-n' && args[i + 1]) {
            const val = args[++i];
            if (val === 'ln' || val === 'rn' || val === 'rz') {
                numberFormat = val;
            } else {
                io.stderr.write(`nl: invalid number format: '${val}'\n`);
                return 1;
            }
        } else if (arg === '-w' && args[i + 1]) {
            width = parseInt(args[++i], 10);
            if (isNaN(width) || width < 1) {
                io.stderr.write(`nl: invalid width: '${args[i]}'\n`);
                return 1;
            }
        } else if (arg === '-s' && args[i + 1]) {
            separator = args[++i];
        } else if (arg === '-v' && args[i + 1]) {
            startNum = parseInt(args[++i], 10);
            if (isNaN(startNum)) {
                io.stderr.write(`nl: invalid starting number: '${args[i]}'\n`);
                return 1;
            }
        } else if (arg === '-i' && args[i + 1]) {
            increment = parseInt(args[++i], 10);
            if (isNaN(increment)) {
                io.stderr.write(`nl: invalid increment: '${args[i]}'\n`);
                return 1;
            }
        } else if (!arg.startsWith('-')) {
            file = arg;
        }
    }

    // Read input
    let content: string;

    if (file) {
        if (!fs) {
            io.stderr.write('nl: filesystem not available\n');
            return 1;
        }
        const resolved = resolvePath(session.cwd, file);
        try {
            const data = await fs.read(resolved);
            content = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`nl: ${file}: ${err.message}\n`);
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

    // Process lines
    const lines = content.split('\n');
    // Remove trailing empty line from split if content ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '' && content.endsWith('\n')) {
        lines.pop();
    }

    let lineNum = startNum;

    for (const line of lines) {
        const shouldNumber =
            bodyNumbering === 'a' ||
            (bodyNumbering === 't' && line.trim().length > 0);

        if (bodyNumbering === 'n' || !shouldNumber) {
            // No numbering - just output the line with spacing
            io.stdout.write(' '.repeat(width) + separator + line + '\n');
        } else {
            const numStr = formatLineNumber(lineNum, width, numberFormat);
            io.stdout.write(numStr + separator + line + '\n');
            lineNum += increment;
        }
    }

    return 0;
};

/**
 * Format line number according to style
 */
function formatLineNumber(num: number, width: number, format: NumberFormat): string {
    const str = String(num);

    switch (format) {
        case 'ln':
            // Left-justified
            return str.padEnd(width);
        case 'rz':
            // Right-justified with leading zeros
            return str.padStart(width, '0');
        case 'rn':
        default:
            // Right-justified with spaces
            return str.padStart(width);
    }
}
