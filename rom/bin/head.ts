/**
 * head - output the first part of files
 *
 * Usage: head [-n N] [file...]
 *
 * Options:
 *   -n N   Output first N lines (default: 10)
 *
 * Args:
 *   file   File(s) to read. If no file, reads from stdin.
 *
 * When multiple files are specified, each is preceded by a header.
 *
 * Examples:
 *   head /tmp/log.txt
 *   head -n 5 /tmp/log.txt
 *   cat file | head -n 20
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
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse -n option
    let maxLines = 10;
    const files: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-n' && argv[i + 1]) {
            const n = parseInt(argv[++i], 10);
            if (isNaN(n) || n < 0) {
                await eprintln(`head: invalid number of lines: '${argv[i]}'`);
                await exit(1);
            }
            maxLines = n;
        } else if (arg.startsWith('-n')) {
            const n = parseInt(arg.slice(2), 10);
            if (isNaN(n) || n < 0) {
                await eprintln(`head: invalid number of lines: '${arg.slice(2)}'`);
                await exit(1);
            }
            maxLines = n;
        } else if (!arg.startsWith('-') || arg === '-') {
            files.push(arg === '-' ? '' : arg);
        }
    }

    // Process stdin or files
    if (files.length === 0) {
        await processStdin(maxLines);
    } else {
        const cwd = await getcwd();
        const showHeaders = files.length > 1;
        let exitCode = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            if (showHeaders) {
                if (i > 0) await println('');
                await println(`==> ${file || 'standard input'} <==`);
            }

            if (!file) {
                await processStdin(maxLines);
            } else {
                const code = await processFile(cwd, file, maxLines);
                if (code !== 0) exitCode = code;
            }
        }

        await exit(exitCode);
    }

    await exit(0);
}

async function processStdin(maxLines: number): Promise<void> {
    let count = 0;
    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            await send(1, msg);
            if (++count >= maxLines) break;
        }
    }
}

async function processFile(cwd: string, file: string, maxLines: number): Promise<number> {
    const path = resolvePath(cwd, file);

    try {
        const content = await readFile(path);
        const allLines = content.split('\n');

        // Remove trailing empty element if content ends with newline
        if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
            allLines.pop();
        }

        const output = allLines.slice(0, maxLines);
        for (const line of output) {
            await println(line);
        }
        return 0;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`head: ${file}: ${msg}`);
        return 1;
    }
}

main().catch(async (err) => {
    await eprintln(`head: ${err.message}`);
    await exit(1);
});
