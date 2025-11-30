/**
 * tee - Read from stdin and write to stdout and files
 *
 * Usage:
 *   <input> | tee <file>       Write to file and stdout
 *   <input> | tee -a <file>    Append to file
 *
 * Examples:
 *   find . | tee /tmp/files.txt
 *   cat file | tee -a /tmp/log.txt
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const tee: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('tee: filesystem not available\n');
        return 1;
    }

    // Parse options
    const append = args.includes('-a') || args.includes('--append');
    const files = args.filter(a => !a.startsWith('-'));

    if (files.length === 0) {
        io.stderr.write('tee: missing file operand\n');
        io.stderr.write('Usage: tee [-a] <file>...\n');
        return 1;
    }

    // Resolve file paths
    const resolvedFiles = files.map(f => resolvePath(session.cwd, f));

    // Collect all input
    let content = '';
    for await (const chunk of io.stdin) {
        const text = chunk.toString();
        content += text;
        // Write to stdout as we receive it
        io.stdout.write(text);
    }

    // Write to each file
    let exitCode = 0;
    for (let i = 0; i < resolvedFiles.length; i++) {
        const filePath = resolvedFiles[i];
        const fileArg = files[i];

        try {
            if (append) {
                // Read existing content and append
                let existing = '';
                try {
                    const data = await fs.read(filePath);
                    existing = data.toString();
                } catch {
                    // File doesn't exist, start fresh
                }
                await fs.write(filePath, existing + content);
            } else {
                await fs.write(filePath, content);
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`tee: ${fileArg}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    return exitCode;
};
