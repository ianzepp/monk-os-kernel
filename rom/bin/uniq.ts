/**
 * uniq - report or filter out repeated lines
 *
 * Usage: uniq [OPTIONS] [file]
 *
 * Options:
 *   -c   Prefix lines with count of occurrences
 *   -d   Only print duplicate lines (ones that appear more than once)
 *   -u   Only print unique lines (ones that appear exactly once)
 *   -i   Ignore case when comparing
 *
 * Args:
 *   file   File to read. If no file, reads from stdin.
 *
 * Note: uniq filters ADJACENT duplicate lines. To remove all duplicates,
 * first pipe through sort: sort file | uniq
 *
 * Examples:
 *   sort file | uniq
 *   sort file | uniq -c
 *   sort file | uniq -d
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

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse options
    let showCount = false;
    let duplicatesOnly = false;
    let uniqueOnly = false;
    let ignoreCase = false;
    let file: string | undefined;

    for (const arg of argv) {
        if (arg.startsWith('-') && arg !== '-') {
            for (const char of arg.slice(1)) {
                if (char === 'c') showCount = true;
                else if (char === 'd') duplicatesOnly = true;
                else if (char === 'u') uniqueOnly = true;
                else if (char === 'i') ignoreCase = true;
            }
        } else {
            file = arg;
        }
    }

    // Read from file or stdin
    let content: string;

    if (file) {
        const cwd = await getcwd();
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
                content = new TextDecoder().decode(buffer);
            } finally {
                await close(fd);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`uniq: ${file}: ${msg}`);
            await exit(1);
        }
    } else {
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
        content = new TextDecoder().decode(buffer);
    }

    // Split into lines
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }

    // Process lines - uniq filters ADJACENT duplicates
    const results: { line: string; count: number }[] = [];
    let prev: string | null = null;
    let prevKey: string | null = null;

    for (const line of lines) {
        const key = ignoreCase ? line.toLowerCase() : line;

        if (key === prevKey && results.length > 0) {
            results[results.length - 1].count++;
        } else {
            results.push({ line, count: 1 });
            prev = line;
            prevKey = key;
        }
    }

    // Output
    for (const { line, count } of results) {
        // Filter based on options
        if (duplicatesOnly && count === 1) continue;
        if (uniqueOnly && count > 1) continue;

        if (showCount) {
            await println(`${String(count).padStart(7)} ${line}`);
        } else {
            await println(line);
        }
    }

    await exit(0);
}

main().catch(async (err) => {
    await eprintln(`uniq: ${err.message}`);
    await exit(1);
});
