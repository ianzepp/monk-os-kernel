/**
 * tr - Translate or delete characters
 *
 * Usage:
 *   tr <set1> <set2>     Replace characters in set1 with set2
 *   tr -d <set1>         Delete characters in set1
 *   tr -s <set1>         Squeeze repeated characters
 *
 * Examples:
 *   echo "hello" | tr a-z A-Z
 *   echo "hello" | tr -d aeiou
 *   echo "heeello" | tr -s e
 */

import type { CommandHandler } from './shared.js';

export const tr: CommandHandler = async (_session, _fs, args, io) => {
    // Parse options
    const deleteMode = args.includes('-d');
    const squeezeMode = args.includes('-s');
    const positional = args.filter(a => !a.startsWith('-'));

    if (positional.length < 1) {
        io.stderr.write('tr: missing operand\n');
        io.stderr.write('Usage: tr [-d|-s] <set1> [set2]\n');
        return 1;
    }

    const set1 = expandSet(positional[0]);
    const set2 = positional[1] ? expandSet(positional[1]) : '';

    if (!deleteMode && !squeezeMode && !set2) {
        io.stderr.write('tr: missing set2 for translation\n');
        return 1;
    }

    // Read all stdin
    let input = '';
    for await (const chunk of io.stdin) {
        input += chunk.toString();
    }

    let output: string;

    if (deleteMode) {
        // Delete characters in set1
        output = deleteChars(input, set1);
    } else if (squeezeMode) {
        // Squeeze repeated characters
        output = squeezeChars(input, set1);
    } else {
        // Translate set1 to set2
        output = translateChars(input, set1, set2);
    }

    io.stdout.write(output);

    return 0;
};

/**
 * Expand character set notation
 * Supports: a-z, A-Z, 0-9, literal characters
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
