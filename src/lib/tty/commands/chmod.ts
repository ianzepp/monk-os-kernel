/**
 * chmod - Change file mode bits
 *
 * Usage:
 *   chmod <mode> <file>...
 *
 * Mode can be:
 *   - Octal: 755, 644, 600
 *   - Symbolic: u+x, g-w, o=r, a+rw
 *
 * Examples:
 *   chmod 755 script.sh
 *   chmod u+x script.sh
 *   chmod go-w file.txt
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';

/**
 * Parse symbolic mode string into mode modifier function
 * Supports: u/g/o/a, +/-/=, r/w/x
 */
function parseSymbolicMode(mode: string, currentMode: number): number | null {
    const match = mode.match(/^([ugoa]*)([+\-=])([rwx]+)$/);
    if (!match) return null;

    const [, whoStr, op, permsStr] = match;
    const who = whoStr || 'a';

    // Calculate permission bits
    let permBits = 0;
    if (permsStr.includes('r')) permBits |= 4;
    if (permsStr.includes('w')) permBits |= 2;
    if (permsStr.includes('x')) permBits |= 1;

    let result = currentMode;

    // Apply to each target (u=owner, g=group, o=other)
    const targets: Array<{ char: string; shift: number }> = [
        { char: 'u', shift: 6 },
        { char: 'g', shift: 3 },
        { char: 'o', shift: 0 },
    ];

    for (const { char, shift } of targets) {
        if (who.includes('a') || who.includes(char)) {
            const shiftedBits = permBits << shift;
            const mask = 0o7 << shift;

            switch (op) {
                case '+':
                    result |= shiftedBits;
                    break;
                case '-':
                    result &= ~shiftedBits;
                    break;
                case '=':
                    result = (result & ~mask) | shiftedBits;
                    break;
            }
        }
    }

    return result;
}

/**
 * Parse mode string (octal or symbolic)
 */
function parseMode(modeStr: string, currentMode: number): number | null {
    // Try octal first
    if (/^[0-7]{3,4}$/.test(modeStr)) {
        return parseInt(modeStr, 8);
    }

    // Try symbolic
    return parseSymbolicMode(modeStr, currentMode);
}

export const chmod: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('chmod: filesystem not available\n');
        return 1;
    }

    // Filter out options (none supported yet, but allow -v for compatibility)
    const positional = args.filter(a => !a.startsWith('-'));

    if (positional.length < 2) {
        io.stderr.write('chmod: missing operand\n');
        io.stderr.write('Usage: chmod <mode> <file>...\n');
        return 1;
    }

    const modeArg = positional[0];
    const files = positional.slice(1);
    let exitCode = 0;

    for (const fileArg of files) {
        const path = resolvePath(session.cwd, fileArg);

        try {
            // Get current mode for symbolic parsing
            const stat = await fs.stat(path);
            const newMode = parseMode(modeArg, stat.mode);

            if (newMode === null) {
                io.stderr.write(`chmod: invalid mode: '${modeArg}'\n`);
                return 1;
            }

            await fs.chmod(path, newMode);
        } catch (err) {
            if (err instanceof FSError) {
                if (err.code === 'ENOENT') {
                    io.stderr.write(`chmod: cannot access '${fileArg}': No such file or directory\n`);
                } else if (err.code === 'EROFS') {
                    io.stderr.write(`chmod: changing permissions of '${fileArg}': Read-only file system\n`);
                } else {
                    io.stderr.write(`chmod: ${fileArg}: ${err.message}\n`);
                }
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    return exitCode;
};
