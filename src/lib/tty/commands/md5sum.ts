/**
 * md5sum - Compute MD5 message digest
 *
 * Usage:
 *   md5sum [file...]
 *   command | md5sum
 *
 * Output format:
 *   <hash>  <filename>
 *   <hash>  -          (when reading from stdin)
 */

import { createHash } from 'crypto';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

export const md5sum: CommandHandler = async (session, fs, args, io) => {
    const files = args.filter(a => !a.startsWith('-'));

    // No files: read from stdin
    if (files.length === 0) {
        const chunks: Buffer[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks);
        const hash = createHash('md5').update(content).digest('hex');
        io.stdout.write(`${hash}  -\n`);
        return 0;
    }

    // Hash each file
    let exitCode = 0;
    for (const file of files) {
        if (io.signal?.aborted) return 130;

        const resolved = resolvePath(session.cwd, file);
        try {
            const content = await fs!.read(resolved);
            const hash = createHash('md5').update(content).digest('hex');
            io.stdout.write(`${hash}  ${file}\n`);
        } catch (err) {
            io.stderr.write(`md5sum: ${file}: No such file\n`);
            exitCode = 1;
        }
    }

    return exitCode;
};
