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
    readText,
    readFile,
    println,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

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
            content = await readFile(path);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`uniq: ${file}: ${msg}`);
            await exit(1);
        }
    } else {
        content = await readText(0);
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
