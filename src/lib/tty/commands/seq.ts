/**
 * seq - print a sequence of numbers
 *
 * Usage:
 *   seq <last>
 *   seq <first> <last>
 *   seq <first> <increment> <last>
 *
 * Options:
 *   -s <sep>    Use separator instead of newline
 *   -w          Equalize width by padding with leading zeros
 *
 * Examples:
 *   seq 5           # 1 2 3 4 5
 *   seq 2 5         # 2 3 4 5
 *   seq 1 2 10      # 1 3 5 7 9
 *   seq -s, 3       # 1,2,3
 *   seq -w 1 10     # 01 02 ... 10
 */

import type { CommandHandler } from './shared.js';

export const seq: CommandHandler = async (session, fs, args, io) => {
    let separator = '\n';
    let equalWidth = false;
    const positional: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-s' && i + 1 < args.length) {
            separator = args[++i];
        } else if (arg === '-w') {
            equalWidth = true;
        } else if (arg.startsWith('-s')) {
            separator = arg.slice(2);
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (positional.length === 0) {
        io.stderr.write('seq: missing operand\n');
        return 1;
    }

    let first = 1;
    let increment = 1;
    let last: number;

    if (positional.length === 1) {
        last = parseFloat(positional[0]);
    } else if (positional.length === 2) {
        first = parseFloat(positional[0]);
        last = parseFloat(positional[1]);
    } else {
        first = parseFloat(positional[0]);
        increment = parseFloat(positional[1]);
        last = parseFloat(positional[2]);
    }

    if (isNaN(first) || isNaN(increment) || isNaN(last)) {
        io.stderr.write('seq: invalid floating point argument\n');
        return 1;
    }

    if (increment === 0) {
        io.stderr.write('seq: invalid Zero increment value\n');
        return 1;
    }

    // Generate sequence
    const numbers: number[] = [];
    if (increment > 0) {
        for (let n = first; n <= last; n += increment) {
            if (io.signal?.aborted) return 130;
            numbers.push(n);
        }
    } else {
        for (let n = first; n >= last; n += increment) {
            if (io.signal?.aborted) return 130;
            numbers.push(n);
        }
    }

    // Format output
    let output: string[];
    if (equalWidth) {
        const maxWidth = Math.max(...numbers.map(n => String(Math.floor(n)).length));
        output = numbers.map(n => {
            const intPart = Math.floor(n);
            const fracPart = n - intPart;
            const padded = String(intPart).padStart(maxWidth, '0');
            return fracPart === 0 ? padded : padded + String(fracPart).slice(1);
        });
    } else {
        output = numbers.map(n => String(n));
    }

    io.stdout.write(output.join(separator) + '\n');
    return 0;
};
