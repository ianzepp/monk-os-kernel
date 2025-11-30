/**
 * printf - format and print data
 *
 * Usage:
 *   printf <format> [arguments...]
 *
 * Format specifiers:
 *   %s      String
 *   %d, %i  Signed decimal integer
 *   %u      Unsigned decimal integer
 *   %o      Octal
 *   %x, %X  Hexadecimal (lower/upper)
 *   %f      Floating point
 *   %e, %E  Scientific notation
 *   %g, %G  Shorter of %f or %e
 *   %c      Character
 *   %%      Literal percent
 *
 * Width and precision:
 *   %10s    Right-align in 10 chars
 *   %-10s   Left-align in 10 chars
 *   %010d   Zero-pad to 10 digits
 *   %.2f    2 decimal places
 *   %10.2f  Width 10, 2 decimals
 *
 * Escape sequences:
 *   \\      Backslash
 *   \n      Newline
 *   \t      Tab
 *   \r      Carriage return
 *   \xHH    Hex byte
 *   \0NNN   Octal byte
 *
 * Examples:
 *   printf "Hello %s\n" world
 *   printf "%d + %d = %d\n" 1 2 3
 *   printf "%-10s %5d\n" "Name" 42
 *   printf "%08x\n" 255
 */

import type { CommandHandler } from './shared.js';

/**
 * Process escape sequences in format string
 */
function processEscapes(str: string): string {
    let result = '';
    let i = 0;

    while (i < str.length) {
        if (str[i] === '\\' && i + 1 < str.length) {
            const next = str[i + 1];
            switch (next) {
                case 'n':
                    result += '\n';
                    i += 2;
                    break;
                case 't':
                    result += '\t';
                    i += 2;
                    break;
                case 'r':
                    result += '\r';
                    i += 2;
                    break;
                case '\\':
                    result += '\\';
                    i += 2;
                    break;
                case 'a':
                    result += '\x07';
                    i += 2;
                    break;
                case 'b':
                    result += '\b';
                    i += 2;
                    break;
                case 'f':
                    result += '\f';
                    i += 2;
                    break;
                case 'v':
                    result += '\v';
                    i += 2;
                    break;
                case 'x': {
                    // Hex escape \xHH
                    const hex = str.slice(i + 2, i + 4);
                    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                        result += String.fromCharCode(parseInt(hex, 16));
                        i += 4;
                    } else {
                        result += str[i];
                        i++;
                    }
                    break;
                }
                case '0': {
                    // Octal escape \0NNN
                    const oct = str.slice(i + 2, i + 5);
                    const match = oct.match(/^([0-7]{1,3})/);
                    if (match) {
                        result += String.fromCharCode(parseInt(match[1], 8));
                        i += 2 + match[1].length;
                    } else {
                        result += '\0';
                        i += 2;
                    }
                    break;
                }
                default:
                    result += str[i];
                    i++;
            }
        } else {
            result += str[i];
            i++;
        }
    }

    return result;
}

/**
 * Format a single value according to format specifier
 */
function formatValue(spec: string, value: string): string {
    // Parse the format specifier: %[flags][width][.precision]type
    const match = spec.match(/^%([-+ #0]*)(\d+)?(?:\.(\d+))?([sdiouxXfFeEgGc%])$/);
    if (!match) return spec;

    const [, flags, widthStr, precisionStr, type] = match;
    const width = widthStr ? parseInt(widthStr, 10) : 0;
    const precision = precisionStr !== undefined ? parseInt(precisionStr, 10) : undefined;
    const leftAlign = flags.includes('-');
    const zeroPad = flags.includes('0') && !leftAlign;
    const plusSign = flags.includes('+');
    const spaceSign = flags.includes(' ');
    const altForm = flags.includes('#');

    let result: string;

    switch (type) {
        case '%':
            return '%';

        case 's':
            result = value;
            if (precision !== undefined) {
                result = result.slice(0, precision);
            }
            break;

        case 'c':
            result = value ? value[0] : '';
            break;

        case 'd':
        case 'i': {
            const num = parseInt(value, 10) || 0;
            result = Math.abs(num).toString();
            if (num < 0) {
                result = '-' + result;
            } else if (plusSign) {
                result = '+' + result;
            } else if (spaceSign) {
                result = ' ' + result;
            }
            break;
        }

        case 'u': {
            const num = parseInt(value, 10) || 0;
            result = (num >>> 0).toString();
            break;
        }

        case 'o': {
            const num = parseInt(value, 10) || 0;
            result = (num >>> 0).toString(8);
            if (altForm && result[0] !== '0') {
                result = '0' + result;
            }
            break;
        }

        case 'x':
        case 'X': {
            const num = parseInt(value, 10) || 0;
            result = (num >>> 0).toString(16);
            if (type === 'X') result = result.toUpperCase();
            if (altForm && num !== 0) {
                result = (type === 'X' ? '0X' : '0x') + result;
            }
            break;
        }

        case 'f':
        case 'F': {
            const num = parseFloat(value) || 0;
            const prec = precision !== undefined ? precision : 6;
            result = num.toFixed(prec);
            if (type === 'F') result = result.toUpperCase();
            break;
        }

        case 'e':
        case 'E': {
            const num = parseFloat(value) || 0;
            const prec = precision !== undefined ? precision : 6;
            result = num.toExponential(prec);
            if (type === 'E') result = result.toUpperCase();
            break;
        }

        case 'g':
        case 'G': {
            const num = parseFloat(value) || 0;
            const prec = precision !== undefined ? precision : 6;
            // Use exponential if exponent < -4 or >= precision
            const exp = Math.floor(Math.log10(Math.abs(num)));
            if (num !== 0 && (exp < -4 || exp >= prec)) {
                result = num.toExponential(prec - 1);
            } else {
                result = num.toPrecision(prec);
            }
            // Remove trailing zeros
            result = result.replace(/\.?0+$/, '');
            if (type === 'G') result = result.toUpperCase();
            break;
        }

        default:
            return spec;
    }

    // Apply width padding
    if (width > result.length) {
        const padChar = zeroPad ? '0' : ' ';
        const padLen = width - result.length;
        if (leftAlign) {
            result = result + ' '.repeat(padLen);
        } else if (zeroPad && (result[0] === '-' || result[0] === '+' || result[0] === ' ')) {
            // Keep sign before zero padding
            result = result[0] + padChar.repeat(padLen) + result.slice(1);
        } else {
            result = padChar.repeat(padLen) + result;
        }
    }

    return result;
}

export const printf: CommandHandler = async (_session, _fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('printf: missing format string\n');
        io.stderr.write('Usage: printf <format> [arguments...]\n');
        return 1;
    }

    const format = processEscapes(args[0]);
    const values = args.slice(1);
    let valueIndex = 0;

    // Parse format string and replace specifiers
    let result = '';
    let i = 0;

    while (i < format.length) {
        if (format[i] === '%') {
            // Find the end of the format specifier
            const specMatch = format.slice(i).match(/^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d+))?([sdiouxXfFeEgGc%])/);

            if (specMatch) {
                let spec = specMatch[0];
                let width = specMatch[2];
                let precision = specMatch[3];

                // Handle * for width/precision (take from args)
                if (width === '*') {
                    const w = parseInt(values[valueIndex++] || '0', 10);
                    spec = spec.replace('*', String(Math.abs(w)));
                    if (w < 0) {
                        spec = spec.replace('%', '%-');
                    }
                }
                if (precision === '*') {
                    const p = parseInt(values[valueIndex++] || '0', 10);
                    spec = spec.replace('.*', '.' + Math.max(0, p));
                }

                const value = values[valueIndex++] || '';
                result += formatValue(spec, value);
                i += specMatch[0].length;
            } else {
                result += format[i];
                i++;
            }
        } else {
            result += format[i];
            i++;
        }
    }

    io.stdout.write(result);
    return 0;
};
