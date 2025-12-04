/**
 * tr - translate or delete characters
 *
 * Usage: tr [OPTIONS] SET1 [SET2]
 *
 * Options:
 *   -d   Delete characters in SET1
 *   -s   Squeeze (replace repeated characters in SET1 with single)
 *
 * Args:
 *   SET1   Source character set
 *   SET2   Replacement character set (required for translation)
 *
 * Character sets support:
 *   - Literal characters: abc
 *   - Ranges: a-z, A-Z, 0-9
 *   - Escape sequences: \n (newline), \t (tab), \r (return), \\ (backslash)
 *
 * Examples:
 *   echo "hello" | tr a-z A-Z      # Convert to uppercase
 *   echo "hello" | tr -d aeiou     # Delete vowels
 *   echo "heeello" | tr -s e       # Squeeze repeated e's
 */

import {
    getargs,
    recv,
    send,
    eprintln,
    exit,
    respond,
} from '@rom/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    // Parse options
    let deleteMode = false;
    let squeezeMode = false;
    const positional: string[] = [];

    for (const arg of argv) {
        if (arg === '-d') {
            deleteMode = true;
        } else if (arg === '-s') {
            squeezeMode = true;
        } else if (arg === '-ds' || arg === '-sd') {
            deleteMode = true;
            squeezeMode = true;
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (positional.length < 1) {
        await eprintln('tr: missing operand');
        await eprintln('Usage: tr [-d|-s] SET1 [SET2]');
        await exit(1);
    }

    const set1Arg = positional[0];
    if (set1Arg === undefined) {
        await eprintln('tr: missing operand');
        return await exit(1);
    }

    const set1 = expandSet(set1Arg);
    const set2 = positional[1] !== undefined ? expandSet(positional[1]) : '';

    if (!deleteMode && !squeezeMode && !set2) {
        await eprintln('tr: missing SET2 for translation');
        await exit(1);
    }

    // Stream through stdin, transforming each item
    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const input = (msg.data as { text: string }).text ?? '';
            let output: string;

            if (deleteMode) {
                output = deleteChars(input, set1);
                if (squeezeMode && set2) {
                    output = squeezeChars(output, set2);
                }
            } else if (squeezeMode) {
                output = squeezeChars(input, set1);
            } else {
                output = translateChars(input, set1, set2);
            }

            await send(1, respond.item({ text: output }));
        }
    }

    await exit(0);
}

/**
 * Expand character set notation
 * Supports: a-z, A-Z, 0-9, literal characters, escape sequences
 */
function expandSet(set: string): string {
    let result = '';
    let i = 0;

    while (i < set.length) {
        // Check for range notation (a-z)
        if (i + 2 < set.length && set[i + 1] === '-') {
            const start = set.charCodeAt(i);
            const end = set.charCodeAt(i + 2);

            if (start <= end) {
                for (let c = start; c <= end; c++) {
                    result += String.fromCharCode(c);
                }
            }
            i += 3;
        } else {
            // Handle escape sequences
            if (set[i] === '\\' && i + 1 < set.length) {
                switch (set[i + 1]) {
                    case 'n': result += '\n'; break;
                    case 't': result += '\t'; break;
                    case 'r': result += '\r'; break;
                    case '\\': result += '\\'; break;
                    default: result += set[i + 1];
                }
                i += 2;
            } else {
                result += set[i];
                i++;
            }
        }
    }

    return result;
}

/**
 * Translate characters from set1 to set2
 */
function translateChars(input: string, set1: string, set2: string): string {
    let result = '';

    for (const char of input) {
        const idx = set1.indexOf(char);
        if (idx !== -1 && idx < set2.length) {
            result += set2[idx];
        } else if (idx !== -1) {
            // If set2 is shorter, use last character of set2
            result += set2[set2.length - 1] || char;
        } else {
            result += char;
        }
    }

    return result;
}

/**
 * Delete characters in set
 */
function deleteChars(input: string, set: string): string {
    let result = '';
    const setChars = new Set(set);

    for (const char of input) {
        if (!setChars.has(char)) {
            result += char;
        }
    }

    return result;
}

/**
 * Squeeze repeated characters in set
 */
function squeezeChars(input: string, set: string): string {
    let result = '';
    const setChars = new Set(set);
    let prevChar = '';

    for (const char of input) {
        // Only squeeze if char is in set and matches previous
        if (setChars.has(char) && char === prevChar) {
            continue;
        }
        result += char;
        prevChar = char;
    }

    return result;
}

main().catch(async (err) => {
    await eprintln(`tr: ${err.message}`);
    await exit(1);
});
