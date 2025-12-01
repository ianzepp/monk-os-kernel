/**
 * wc - word, line, and byte count
 *
 * Usage: wc [-lwc] [file...]
 *
 * Options:
 *   -l   Print line count
 *   -w   Print word count
 *   -c   Print character (byte) count
 *
 * Args:
 *   file   File(s) to read. If no file, reads from stdin.
 *
 * Default (no options): prints lines, words, and characters.
 * When multiple files, prints a total line.
 *
 * Examples:
 *   wc /tmp/file.txt
 *   wc -l /tmp/file.txt
 *   find . | wc -l
 */

import {
    getargs,
    getcwd,
    open,
    read,
    close,
    println,
    eprintln,
    exit,
} from '/lib/process';
import { resolvePath } from '/lib/shell';

interface Counts {
    lines: number;
    words: number;
    chars: number;
}

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse options
    let showLines = false;
    let showWords = false;
    let showChars = false;
    const files: string[] = [];

    for (const arg of argv) {
        if (arg.startsWith('-') && arg !== '-') {
            for (const char of arg.slice(1)) {
                if (char === 'l') showLines = true;
                else if (char === 'w') showWords = true;
                else if (char === 'c') showChars = true;
            }
        } else {
            files.push(arg === '-' ? '' : arg);
        }
    }

    // Default: show all
    if (!showLines && !showWords && !showChars) {
        showLines = showWords = showChars = true;
    }

    const options = { showLines, showWords, showChars };

    // Process stdin or files
    if (files.length === 0) {
        const counts = await processStdin();
        await printCounts(counts, '', options);
    } else {
        const cwd = await getcwd();
        let exitCode = 0;
        let total: Counts = { lines: 0, words: 0, chars: 0 };

        for (const file of files) {
            if (!file) {
                const counts = await processStdin();
                await printCounts(counts, '', options);
                total.lines += counts.lines;
                total.words += counts.words;
                total.chars += counts.chars;
            } else {
                const result = await processFile(cwd, file);
                if (result === null) {
                    exitCode = 1;
                } else {
                    await printCounts(result, file, options);
                    total.lines += result.lines;
                    total.words += result.words;
                    total.chars += result.chars;
                }
            }
        }

        if (files.length > 1) {
            await printCounts(total, 'total', options);
        }

        await exit(exitCode);
    }

    await exit(0);
}

async function processStdin(): Promise<Counts> {
    const chunks: Uint8Array[] = [];
    while (true) {
        const chunk = await read(0, 4096);
        if (chunk.length === 0) break;
        chunks.push(chunk);
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
    }

    return countContent(new TextDecoder().decode(buffer));
}

async function processFile(cwd: string, file: string): Promise<Counts | null> {
    const path = resolvePath(cwd, file);

    try {
        const fd = await open(path, { read: true });
        try {
            const chunks: Uint8Array[] = [];
            while (true) {
                const chunk = await read(fd, 65536);
                if (chunk.length === 0) break;
                chunks.push(chunk);
            }

            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            const buffer = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                buffer.set(chunk, offset);
                offset += chunk.length;
            }

            return countContent(new TextDecoder().decode(buffer));
        } finally {
            await close(fd);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`wc: ${file}: ${msg}`);
        return null;
    }
}

function countContent(content: string): Counts {
    const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const chars = content.length;

    return { lines, words, chars };
}

async function printCounts(
    counts: Counts,
    name: string,
    options: { showLines: boolean; showWords: boolean; showChars: boolean }
): Promise<void> {
    const parts: string[] = [];

    if (options.showLines) parts.push(String(counts.lines).padStart(8));
    if (options.showWords) parts.push(String(counts.words).padStart(8));
    if (options.showChars) parts.push(String(counts.chars).padStart(8));
    if (name) parts.push(` ${name}`);

    await println(parts.join(''));
}

main().catch(async (err) => {
    await eprintln(`wc: ${err.message}`);
    await exit(1);
});
