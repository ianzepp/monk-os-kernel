/**
 * cut - remove sections from each line
 *
 * Usage: cut -d DELIM -f FIELDS [file]
 *        cut -c CHARS [file]
 *
 * Options:
 *   -d DELIM   Use DELIM as field delimiter (default: tab)
 *   -f FIELDS  Select fields (1-indexed): 1,3,5 or 1-3,5
 *   -c CHARS   Select character positions: 1-10 or 1,5,10
 *
 * Args:
 *   file   File to read. If no file, reads from stdin.
 *
 * Examples:
 *   echo "a,b,c" | cut -d, -f2           # Output: b
 *   cat /etc/passwd | cut -d: -f1,3      # User and UID
 *   cat file | cut -c1-10                # First 10 characters
 */

import {
    getargs,
    getcwd,
    readFile,
    recv,
    send,
    println,
    eprintln,
    exit,
    respond,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse options
    let delimiter = '\t';
    let fields: number[] = [];
    let chars: { start: number; end: number }[] = [];
    let file: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg) continue;

        if (arg.startsWith('-d')) {
            // Delimiter: -d, or -d ,
            if (arg.length > 2) {
                delimiter = arg.slice(2);
            } else {
                const nextArg = argv[++i];
                delimiter = nextArg || '\t';
            }
        } else if (arg.startsWith('-f')) {
            // Fields: -f1,2,3 or -f 1,2,3
            const fieldStr = arg.length > 2 ? arg.slice(2) : argv[++i];
            if (fieldStr) {
                fields = parseRanges(fieldStr);
            }
        } else if (arg.startsWith('-c')) {
            // Characters: -c1-10 or -c 1-10
            const charStr = arg.length > 2 ? arg.slice(2) : argv[++i];
            if (charStr) {
                chars = parseCharRanges(charStr);
            }
        } else if (!arg.startsWith('-')) {
            file = arg;
        }
    }

    if (fields.length === 0 && chars.length === 0) {
        await eprintln('cut: you must specify -f or -c');
        await eprintln('Usage: cut -d DELIM -f FIELDS [file]');
        await eprintln('       cut -c CHARS [file]');
        await exit(1);
    }

    if (file) {
        // File mode: read bytes, process as text
        const cwd = await getcwd();
        const path = resolvePath(cwd, file);

        let content: string;
        try {
            content = await readFile(path);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`cut: ${file}: ${msg}`);
            await exit(1);
            return;
        }

        const lines = content.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();

        for (const line of lines) {
            const output = chars.length > 0
                ? extractChars(line, chars)
                : extractFields(line, delimiter, fields);
            await println(output);
        }
    } else {
        // Stdin mode: stream message items
        for await (const msg of recv(0)) {
            if (msg.op === 'item') {
                const text = (msg.data as { text: string }).text ?? '';
                const line = text.replace(/\n$/, '');
                const output = chars.length > 0
                    ? extractChars(line, chars)
                    : extractFields(line, delimiter, fields);
                await send(1, respond.item({ text: output + '\n' }));
            }
        }
    }

    await exit(0);
}

/**
 * Parse field ranges like "1,3,5" or "1-3,5"
 */
function parseRanges(str: string): number[] {
    const result: number[] = [];

    for (const part of str.split(',')) {
        if (part.includes('-')) {
            const parts = part.split('-');
            const start = parts[0] ? parseInt(parts[0], 10) : NaN;
            const end = parts[1] ? parseInt(parts[1], 10) : NaN;
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end; i++) {
                    result.push(i);
                }
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
            const parts = part.split('-');
            const start = parts[0] ? parseInt(parts[0], 10) : NaN;
            const end = parts[1] ? parseInt(parts[1], 10) : NaN;
            if (!isNaN(start) && !isNaN(end)) {
                result.push({ start: start - 1, end: end }); // Convert to 0-indexed
            }
        } else {
            const n = parseInt(part, 10);
            if (!isNaN(n)) {
                result.push({ start: n - 1, end: n });
            }
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
        const part = parts[f - 1];
        if (part !== undefined) {
            selected.push(part);
        }
    }

    return selected.join(delimiter);
}

main().catch(async (err) => {
    await eprintln(`cut: ${err.message}`);
    await exit(1);
});
