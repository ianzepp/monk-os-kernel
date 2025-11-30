/**
 * shasum - Compute SHA message digest
 *
 * Usage:
 *   shasum [-a algorithm] [file...]
 *   command | shasum [-a algorithm]
 *
 * Options:
 *   -a <algo>   Algorithm: 1, 256, 384, 512 (default: 1)
 *
 * Output format:
 *   <hash>  <filename>
 *   <hash>  -          (when reading from stdin)
 */

import { createHash } from 'crypto';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

const ALGORITHMS: Record<string, string> = {
    '1': 'sha1',
    '256': 'sha256',
    '384': 'sha384',
    '512': 'sha512',
};

export const shasum: CommandHandler = async (session, fs, args, io) => {
    let algorithm = 'sha1';
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-a' && i + 1 < args.length) {
            const algoArg = args[++i];
            if (!ALGORITHMS[algoArg]) {
                io.stderr.write(`shasum: invalid algorithm: ${algoArg}\n`);
                io.stderr.write('Supported: 1, 256, 384, 512\n');
                return 1;
            }
            algorithm = ALGORITHMS[algoArg];
        } else if (!arg.startsWith('-')) {
            files.push(arg);
        }
    }

    // No files: read from stdin
    if (files.length === 0) {
        const chunks: Buffer[] = [];
        for await (const chunk of io.stdin) {
            chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks);
        const hash = createHash(algorithm).update(content).digest('hex');
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
            const hash = createHash(algorithm).update(content).digest('hex');
            io.stdout.write(`${hash}  ${file}\n`);
        } catch (err) {
            io.stderr.write(`shasum: ${file}: No such file\n`);
            exitCode = 1;
        }
    }

    return exitCode;
};
