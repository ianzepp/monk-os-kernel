/**
 * seq - print a sequence of numbers
 *
 * Usage: seq [OPTIONS] LAST
 *        seq [OPTIONS] FIRST LAST
 *        seq [OPTIONS] FIRST INCREMENT LAST
 *
 * Options:
 *   -s SEP   Use SEP as separator (default: newline)
 *   -w       Equalize width by padding with leading zeros
 *
 * Args:
 *   FIRST      Starting number (default: 1)
 *   INCREMENT  Step value (default: 1)
 *   LAST       Ending number (inclusive)
 *
 * Examples:
 *   seq 5           # 1 2 3 4 5
 *   seq 2 5         # 2 3 4 5
 *   seq 1 2 10      # 1 3 5 7 9
 *   seq -s, 3       # 1,2,3
 *   seq -w 1 10     # 01 02 ... 10
 */

import { getargs, println, eprintln, exit, onSignal, SIGTERM } from '@rom/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    let separator = '\n';
    let equalWidth = false;
    const positional: string[] = [];

    // Parse arguments
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-s' && i + 1 < argv.length) {
            separator = argv[++i];
        } else if (arg === '-w') {
            equalWidth = true;
        } else if (arg.startsWith('-s')) {
            separator = arg.slice(2);
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (positional.length === 0) {
        await eprintln('seq: missing operand');
        await exit(1);
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
        await eprintln('seq: invalid floating point argument');
        await exit(1);
    }

    if (increment === 0) {
        await eprintln('seq: invalid Zero increment value');
        await exit(1);
    }

    // Signal handling for interruption
    let running = true;
    onSignal((signal) => {
        if (signal === SIGTERM) {
            running = false;
        }
    });

    // Generate sequence
    const numbers: number[] = [];
    if (increment > 0) {
        for (let n = first; n <= last && running; n += increment) {
            numbers.push(n);
        }
    } else {
        for (let n = first; n >= last && running; n += increment) {
            numbers.push(n);
        }
    }

    if (!running) {
        await exit(130);
    }

    // Format output
    let output: string[];
    if (equalWidth) {
        const maxWidth = Math.max(...numbers.map(n => String(Math.floor(Math.abs(n))).length));
        output = numbers.map(n => {
            const intPart = Math.floor(Math.abs(n));
            const sign = n < 0 ? '-' : '';
            const fracPart = Math.abs(n) - intPart;
            const padded = String(intPart).padStart(maxWidth, '0');
            return sign + (fracPart === 0 ? padded : padded + String(fracPart).slice(1));
        });
    } else {
        output = numbers.map(n => String(n));
    }

    await println(output.join(separator));
    await exit(0);
}

main().catch(async (err) => {
    await eprintln(`seq: ${err.message}`);
    await exit(1);
});
