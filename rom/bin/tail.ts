/**
 * tail - output the last part of files
 *
 * Usage: tail [-n N] [file...]
 *
 * Options:
 *   -n N   Output last N lines (default: 10)
 *
 * Args:
 *   file   File(s) to read. If no file, reads from stdin.
 *
 * When multiple files are specified, each is preceded by a header.
 *
 * Examples:
 *   tail /tmp/log.txt
 *   tail -n 5 /tmp/log.txt
 *   cat file | tail -n 20
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

    // Parse -n option
    let maxLines = 10;
    const files: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === undefined) {
            continue;
        }

        if (arg === '-n' && argv[i + 1]) {
            const val = argv[++i];

            if (val === undefined) {
                continue;
            }

            const n = parseInt(val, 10);

            if (isNaN(n) || n < 0) {
                await eprintln(`tail: invalid number of lines: '${val}'`);
                await exit(1);
            }

            maxLines = n;
        }
        else if (arg.startsWith('-n')) {
            const n = parseInt(arg.slice(2), 10);

            if (isNaN(n) || n < 0) {
                await eprintln(`tail: invalid number of lines: '${arg.slice(2)}'`);
                await exit(1);
            }

            maxLines = n;
        }
        else if (!arg.startsWith('-') || arg === '-') {
            files.push(arg === '-' ? '' : arg);
        }
    }

    // Process stdin or files
    if (files.length === 0) {
        await processStdin(maxLines);
    }
    else {
        const cwd = await getcwd();
        const showHeaders = files.length > 1;
        let exitCode = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            if (file === undefined) {
                continue;
            }

            if (showHeaders) {
                if (i > 0) {
                    await println('');
                }

                await println(`==> ${file || 'standard input'} <==`);
            }

            if (!file) {
                await processStdin(maxLines);
            }
            else {
                const code = await processFile(cwd, file, maxLines);

                if (code !== 0) {
                    exitCode = code;
                }
            }
        }

        await exit(exitCode);
    }

    await exit(0);
}

async function processStdin(maxLines: number): Promise<void> {
    // FIFO buffer of last N items
    const buffer: Response[] = [];

    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            buffer.push(msg);
            if (buffer.length > maxLines) {
                buffer.shift();
            }
        }
    }

    // Output buffered items
    for (const msg of buffer) {
        await send(1, msg);
    }
}

async function processFile(cwd: string, file: string, maxLines: number): Promise<number> {
    const path = resolvePath(cwd, file);

    try {
        const content = await readFile(path);
        const allLines = content.split('\n');

        // Remove trailing empty line if content ends with newline
        const lastLine = allLines[allLines.length - 1];

        if (lastLine !== undefined && lastLine === '') {
            allLines.pop();
        }

        const start = Math.max(0, allLines.length - maxLines);
        const output = allLines.slice(start);

        for (const line of output) {
            await println(line);
        }

        return 0;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`tail: ${file}: ${msg}`);

        return 1;
    }
}

main().catch(async err => {
    await eprintln(`tail: ${err.message}`);
    await exit(1);
});
