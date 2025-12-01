/**
 * nl - number lines of files
 *
 * Usage: nl [OPTIONS] [file]
 *
 * Options:
 *   -b STYLE   Body numbering style: 'a' (all), 't' (non-empty), 'n' (none)
 *              Default: 'a'
 *   -n FORMAT  Number format: 'ln' (left), 'rn' (right), 'rz' (right with zeros)
 *              Default: 'rn'
 *   -w N       Line number width (default: 6)
 *   -s SEP     Separator between number and line (default: tab)
 *   -v N       Starting line number (default: 1)
 *   -i N       Line number increment (default: 1)
 *
 * Args:
 *   file   File to read. If no file, reads from stdin.
 *
 * Examples:
 *   nl file.txt                     # Number all lines
 *   nl -b t file.txt                # Number non-empty lines
 *   nl -n rz -w 4 file.txt          # Zero-padded 4-digit numbers
 *   cat file.txt | nl -s ": "       # Custom separator
 */

import {
    getargs,
    getcwd,
    readText,
    readFile,
    println,
    eprintln,
    exit,
} from '/lib/process';
import { resolvePath } from '/lib/shell';

type BodyNumbering = 'a' | 't' | 'n';
type NumberFormat = 'ln' | 'rn' | 'rz';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    let bodyNumbering: BodyNumbering = 'a';
    let numberFormat: NumberFormat = 'rn';
    let width = 6;
    let separator = '\t';
    let startNum = 1;
    let increment = 1;
    let file: string | undefined;

    // Parse arguments
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '-b' && argv[i + 1]) {
            const val = argv[++i];
            if (val === 'a' || val === 't' || val === 'n') {
                bodyNumbering = val;
            } else {
                await eprintln(`nl: invalid body numbering style: '${val}'`);
                await exit(1);
            }
        } else if (arg === '-n' && argv[i + 1]) {
            const val = argv[++i];
            if (val === 'ln' || val === 'rn' || val === 'rz') {
                numberFormat = val;
            } else {
                await eprintln(`nl: invalid number format: '${val}'`);
                await exit(1);
            }
        } else if (arg === '-w' && argv[i + 1]) {
            width = parseInt(argv[++i], 10);
            if (isNaN(width) || width < 1) {
                await eprintln(`nl: invalid width: '${argv[i]}'`);
                await exit(1);
            }
        } else if (arg === '-s' && argv[i + 1]) {
            separator = argv[++i];
        } else if (arg === '-v' && argv[i + 1]) {
            startNum = parseInt(argv[++i], 10);
            if (isNaN(startNum)) {
                await eprintln(`nl: invalid starting number: '${argv[i]}'`);
                await exit(1);
            }
        } else if (arg === '-i' && argv[i + 1]) {
            increment = parseInt(argv[++i], 10);
            if (isNaN(increment)) {
                await eprintln(`nl: invalid increment: '${argv[i]}'`);
                await exit(1);
            }
        } else if (!arg.startsWith('-')) {
            file = arg;
        }
    }

    // Read input
    let content: string;

    if (file) {
        const cwd = await getcwd();
        const path = resolvePath(cwd, file);

        try {
            content = await readFile(path);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`nl: ${file}: ${msg}`);
            await exit(1);
        }
    } else {
        content = await readText(0);
    }

    // Process lines
    const lines = content.split('\n');
    // Remove trailing empty line if content ends with newline
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
            await println(' '.repeat(width) + separator + line);
        } else {
            const numStr = formatLineNumber(lineNum, width, numberFormat);
            await println(numStr + separator + line);
            lineNum += increment;
        }
    }

    await exit(0);
}

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

main().catch(async (err) => {
    await eprintln(`nl: ${err.message}`);
    await exit(1);
});
