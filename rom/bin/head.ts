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
    open,
    read,
    write,
    close,
    println,
    eprintln,
    exit,
} from '/lib/process';
import { resolvePath } from '/lib/shell';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse -n option
    let lines = 10;
    const files: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-n' && argv[i + 1]) {
            const n = parseInt(argv[++i], 10);
            if (isNaN(n) || n < 0) {
                await eprintln(`head: invalid number of lines: '${argv[i]}'`);
                await exit(1);
            }
            lines = n;
        } else if (arg.startsWith('-n')) {
            const n = parseInt(arg.slice(2), 10);
            if (isNaN(n) || n < 0) {
                await eprintln(`head: invalid number of lines: '${arg.slice(2)}'`);
                await exit(1);
            }
            lines = n;
        } else if (!arg.startsWith('-') || arg === '-') {
            files.push(arg === '-' ? '' : arg);
        }
    }

    // Process stdin or files
    if (files.length === 0) {
        await processStdin(lines);
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
                await processStdin(lines);
            } else {
                const code = await processFile(cwd, file, lines);
                if (code !== 0) exitCode = code;
            }
        }

        await exit(exitCode);
    }

    await exit(0);
}

async function processStdin(lines: number): Promise<void> {
    // Read all stdin, then output first N lines
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

    const content = new TextDecoder().decode(buffer);
    outputFirstLines(content, lines);
}

async function processFile(cwd: string, file: string, lines: number): Promise<number> {
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

            const content = new TextDecoder().decode(buffer);
            await outputFirstLines(content, lines);
            return 0;
        } finally {
            await close(fd);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`head: ${file}: ${msg}`);
        return 1;
    }
}

async function outputFirstLines(content: string, lines: number): Promise<void> {
    const allLines = content.split('\n');

    // Remove trailing empty element if content ends with newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
    }

    const output = allLines.slice(0, lines);

    for (const line of output) {
        await println(line);
    }
}

main().catch(async (err) => {
    await eprintln(`head: ${err.message}`);
    await exit(1);
});
