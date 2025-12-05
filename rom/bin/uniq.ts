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

import type { Response } from '@os/process';
import {
    getargs,
    getcwd,
    readFile,
    recv,
    send,
    println,
    eprintln,
    exit,
} from '@os/process';
import { resolvePath } from '@os/shell';

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
                if (char === 'c') {
                    showCount = true;
                }
                else if (char === 'd') {
                    duplicatesOnly = true;
                }
                else if (char === 'u') {
                    uniqueOnly = true;
                }
                else if (char === 'i') {
                    ignoreCase = true;
                }
            }
        }
        else {
            file = arg;
        }
    }

    if (file) {
        // File mode: read bytes, process as text
        const cwd = await getcwd();
        const path = resolvePath(cwd, file);

        let content: string;

        try {
            content = await readFile(path);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`uniq: ${file}: ${msg}`);

            return await exit(1);
        }

        const lines = content.split('\n');
        const lastLine = lines[lines.length - 1];

        if (lastLine !== undefined && lastLine === '') {
            lines.pop();
        }

        await processLines(lines, { showCount, duplicatesOnly, uniqueOnly, ignoreCase });
    }
    else {
        // Stdin mode: stream message items
        await processStdin({ showCount, duplicatesOnly, uniqueOnly, ignoreCase });
    }

    await exit(0);
}

interface UniqOptions {
    showCount: boolean;
    duplicatesOnly: boolean;
    uniqueOnly: boolean;
    ignoreCase: boolean;
}

async function processStdin(options: UniqOptions): Promise<void> {
    const { showCount, duplicatesOnly, uniqueOnly, ignoreCase } = options;

    let prevMsg: Response | null = null;
    let prevKey: string | null = null;
    let count = 0;

    const outputItem = async (msg: Response, cnt: number) => {
        if (duplicatesOnly && cnt === 1) {
            return;
        }

        if (uniqueOnly && cnt > 1) {
            return;
        }

        if (showCount) {
            const text = (msg.data as { text: string }).text ?? '';
            const line = text.replace(/\n$/, '');

            await println(`${String(cnt).padStart(7)} ${line}`);
        }
        else {
            await send(1, msg);
        }
    };

    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const text = (msg.data as { text: string }).text ?? '';
            const key = ignoreCase ? text.toLowerCase() : text;

            if (key === prevKey) {
                count++;
            }
            else {
                if (prevMsg) {
                    await outputItem(prevMsg, count);
                }

                prevMsg = msg;
                prevKey = key;
                count = 1;
            }
        }
    }

    // Output final item
    if (prevMsg) {
        await outputItem(prevMsg, count);
    }
}

async function processLines(lines: string[], options: UniqOptions): Promise<void> {
    const { showCount, duplicatesOnly, uniqueOnly, ignoreCase } = options;

    const results: { line: string; count: number }[] = [];
    let prevKey: string | null = null;

    for (const line of lines) {
        const key = ignoreCase ? line.toLowerCase() : line;

        if (key === prevKey && results.length > 0) {
            const lastResult = results[results.length - 1];

            if (lastResult !== undefined) {
                lastResult.count++;
            }
        }
        else {
            results.push({ line, count: 1 });
            prevKey = key;
        }
    }

    for (const { line, count } of results) {
        if (duplicatesOnly && count === 1) {
            continue;
        }

        if (uniqueOnly && count > 1) {
            continue;
        }

        if (showCount) {
            await println(`${String(count).padStart(7)} ${line}`);
        }
        else {
            await println(line);
        }
    }
}

main().catch(async err => {
    await eprintln(`uniq: ${err.message}`);
    await exit(1);
});
