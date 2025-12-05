/**
 * sort - sort lines of text
 *
 * Usage: sort [OPTIONS] [file...]
 *
 * Options:
 *   -r          Reverse sort order
 *   -n          Numeric sort
 *   -u          Remove duplicate lines (unique)
 *   -f          Fold case (case-insensitive)
 *   -b          Ignore leading blanks
 *   -d          Dictionary order (alphanumeric + space only)
 *   -h          Human numeric sort (2K, 1G, etc.)
 *   -k KEY      Sort by field (e.g., -k2 or -k2,3)
 *   -t SEP      Field separator (default: whitespace)
 *   -o FILE     Write to FILE instead of stdout
 *   -c          Check if sorted, exit 1 if not
 *   -s          Stable sort (preserve order of equal elements)
 *
 * Args:
 *   file        File(s) to sort. If no file, reads from stdin.
 *
 * Examples:
 *   sort file.txt                # Sort alphabetically
 *   sort -n numbers.txt          # Sort numerically
 *   sort -u file.txt             # Sort and remove duplicates
 *   sort -t: -k3 /etc/passwd     # Sort by field 3, colon-separated
 *   sort -rn scores.txt          # Reverse numeric sort
 */

import type { Response } from '@rom/lib/process';
import {
    getargs,
    getcwd,
    open,
    readFile,
    write,
    close,
    recv,
    send,
    eprintln,
    exit,
    respond,
} from '@rom/lib/process';
import { parseArgs, resolvePath } from '@rom/lib/shell';

const argSpecs = {
    reverse: { short: 'r', desc: 'Reverse order' },
    numeric: { short: 'n', desc: 'Numeric sort' },
    unique: { short: 'u', desc: 'Remove duplicates' },
    ignoreCase: { short: 'f', desc: 'Case-insensitive' },
    ignoreBlanks: { short: 'b', desc: 'Ignore leading blanks' },
    dictionary: { short: 'd', desc: 'Dictionary order' },
    human: { short: 'h', desc: 'Human numeric sort' },
    key: { short: 'k', value: true, desc: 'Sort key' },
    separator: { short: 't', value: true, desc: 'Field separator' },
    output: { short: 'o', value: true, desc: 'Output file' },
    check: { short: 'c', desc: 'Check sorted' },
    stable: { short: 's', desc: 'Stable sort' },
};

interface SortOptions {
    reverse: boolean;
    numeric: boolean;
    unique: boolean;
    ignoreCase: boolean;
    ignoreBlanks: boolean;
    dictionary: boolean;
    human: boolean;
    key: { start: number; end: number | null } | null;
    separator: string | null;
    output: string | null;
    check: boolean;
    stable: boolean;
}

async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`sort: ${err}`);
        }

        await exit(1);
    }

    // Parse key specification
    let key: { start: number; end: number | null } | null = null;

    if (typeof parsed.flags.key === 'string') {
        key = parseKeySpec(parsed.flags.key);
        if (!key) {
            await eprintln(`sort: invalid key specification: ${parsed.flags.key}`);
            await exit(1);
        }
    }

    const options: SortOptions = {
        reverse: Boolean(parsed.flags.reverse),
        numeric: Boolean(parsed.flags.numeric),
        unique: Boolean(parsed.flags.unique),
        ignoreCase: Boolean(parsed.flags.ignoreCase),
        ignoreBlanks: Boolean(parsed.flags.ignoreBlanks),
        dictionary: Boolean(parsed.flags.dictionary),
        human: Boolean(parsed.flags.human),
        key,
        separator: typeof parsed.flags.separator === 'string' ? parsed.flags.separator : null,
        output: typeof parsed.flags.output === 'string' ? parsed.flags.output : null,
        check: Boolean(parsed.flags.check),
        stable: Boolean(parsed.flags.stable),
    };

    const files = parsed.positional;
    const cwd = await getcwd();

    // Collect items from stdin or read from files
    let items: { msg: Response; text: string }[] = [];

    if (files.length === 0) {
        // Stdin: collect message items
        for await (const msg of recv(0)) {
            if (msg.op === 'item') {
                const text = ((msg.data as { text: string }).text ?? '').replace(/\n$/, '');

                items.push({ msg, text });
            }
        }
    }
    else {
        // Files: read bytes, convert to items
        for (const file of files) {
            const content = await readFileContent(cwd, file);

            if (content === null) {
                return await exit(1);
            }

            const lines = content.split('\n');
            const lastLine = lines[lines.length - 1];

            if (lastLine !== undefined && lastLine === '') {
                lines.pop();
            }

            for (const text of lines) {
                items.push({ msg: respond.item({ text: text + '\n' }), text });
            }
        }
    }

    // Check mode
    if (options.check) {
        const lines = items.map(i => i.text);

        if (checkSorted(lines, options)) {
            await exit(0);
        }

        await eprintln('sort: input is not sorted');
        await exit(1);
    }

    // Sort
    if (options.stable) {
        const indexed = items.map((item, i) => ({ item, index: i }));

        indexed.sort((a, b) => {
            const cmp = compareLines(a.item.text, b.item.text, options);

            return cmp !== 0 ? cmp : a.index - b.index;
        });
        items = indexed.map(x => x.item);
    }
    else {
        items.sort((a, b) => compareLines(a.text, b.text, options));
    }

    // Unique
    if (options.unique) {
        const seen = new Set<string>();

        items = items.filter(item => {
            const key = options.ignoreCase ? item.text.toLowerCase() : item.text;

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);

            return true;
        });
    }

    // Output
    if (options.output) {
        const outPath = resolvePath(cwd, options.output);

        try {
            const fd = await open(outPath, { write: true, create: true, truncate: true });

            try {
                const output = items.map(i => i.text + '\n').join('');

                await write(fd, new TextEncoder().encode(output));
            }
            finally {
                await close(fd);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`sort: ${options.output}: ${msg}`);
            await exit(1);
        }
    }
    else {
        for (const item of items) {
            await send(1, item.msg);
        }
    }

    await exit(0);
}

async function readFileContent(cwd: string, file: string): Promise<string | null> {
    const path = resolvePath(cwd, file);

    try {
        return await readFile(path);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`sort: ${file}: ${msg}`);

        return null;
    }
}

function parseKeySpec(spec: string): { start: number; end: number | null } | null {
    const match = spec.match(/^(\d+)(?:,(\d+))?$/);

    if (!match || match[1] === undefined) {
        return null;
    }

    return {
        start: parseInt(match[1], 10),
        end: match[2] !== undefined ? parseInt(match[2], 10) : null,
    };
}

function parseHumanSize(str: string): number {
    const match = str.match(/^([\d.]+)\s*([KMGTPE])?i?[Bb]?$/i);

    if (!match || match[1] === undefined) {
        return parseFloat(str) || 0;
    }

    const num = parseFloat(match[1]);
    const unit = (match[2] || '').toUpperCase();
    const multipliers: Record<string, number> = {
        '': 1,
        'K': 1024,
        'M': 1024 ** 2,
        'G': 1024 ** 3,
        'T': 1024 ** 4,
        'P': 1024 ** 5,
        'E': 1024 ** 6,
    };

    return num * (multipliers[unit] || 1);
}

function extractKey(line: string, options: SortOptions): string {
    if (!options.key) {
        return line;
    }

    const sep = options.separator || /\s+/;
    const fields = line.split(sep);
    const start = options.key.start - 1;
    const end = options.key.end !== null ? options.key.end : start + 1;

    if (start < 0 || start >= fields.length) {
        return '';
    }

    return fields.slice(start, end).join(' ');
}

function normalizeForCompare(line: string, options: SortOptions): string {
    let result = line;

    if (options.ignoreBlanks) {
        result = result.trimStart();
    }

    if (options.dictionary) {
        result = result.replace(/[^a-zA-Z0-9\s]/g, '');
    }

    if (options.ignoreCase) {
        result = result.toLowerCase();
    }

    return result;
}

function compareLines(a: string, b: string, options: SortOptions): number {
    const keyA = extractKey(a, options);
    const keyB = extractKey(b, options);
    const normA = normalizeForCompare(keyA, options);
    const normB = normalizeForCompare(keyB, options);

    let result: number;

    if (options.human) {
        result = parseHumanSize(normA) - parseHumanSize(normB);
    }
    else if (options.numeric) {
        result = (parseFloat(normA) || 0) - (parseFloat(normB) || 0);
    }
    else {
        result = normA.localeCompare(normB);
    }

    return options.reverse ? -result : result;
}

function checkSorted(lines: string[], options: SortOptions): boolean {
    for (let i = 1; i < lines.length; i++) {
        const prev = lines[i - 1];
        const curr = lines[i];

        if (prev !== undefined && curr !== undefined && compareLines(prev, curr, options) > 0) {
            return false;
        }
    }

    return true;
}

main().catch(async err => {
    await eprintln(`sort: ${err.message}`);
    await exit(1);
});
