/**
 * date - Display or set the system date and time
 *
 * Usage:
 *   date              Show current date/time
 *   date -u           Show UTC time
 *   date -I           Show ISO 8601 format
 *   date +FORMAT      Custom format
 *
 * Examples:
 *   date
 *   date -u
 *   date +%Y-%m-%d
 */

import type { CommandHandler } from './shared.js';

export const date: CommandHandler = async (_session, _fs, args, io) => {
    const now = new Date();

    // Parse options
    const utc = args.includes('-u') || args.includes('--utc');
    const iso = args.includes('-I') || args.includes('--iso-8601');
    const formatArg = args.find(a => a.startsWith('+'));

    if (iso) {
        io.stdout.write(now.toISOString() + '\n');
        return 0;
    }

    if (formatArg) {
        const format = formatArg.slice(1);
        const result = formatDate(now, format, utc);
        io.stdout.write(result + '\n');
        return 0;
    }

    // Default format like Unix date
    if (utc) {
        io.stdout.write(now.toUTCString() + '\n');
    } else {
        io.stdout.write(now.toString() + '\n');
    }

    return 0;
};

/**
 * Format date with strftime-like format codes
 */
function formatDate(date: Date, format: string, utc: boolean): string {
    const pad = (n: number, len = 2) => String(n).padStart(len, '0');

    const year = utc ? date.getUTCFullYear() : date.getFullYear();
    const month = utc ? date.getUTCMonth() : date.getMonth();
    const day = utc ? date.getUTCDate() : date.getDate();
    const hours = utc ? date.getUTCHours() : date.getHours();
    const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
    const seconds = utc ? date.getUTCSeconds() : date.getSeconds();
    const dayOfWeek = utc ? date.getUTCDay() : date.getDay();

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    return format.replace(/%(.)/g, (_, code) => {
        switch (code) {
            case 'Y': return String(year);
            case 'y': return String(year).slice(-2);
            case 'm': return pad(month + 1);
            case 'd': return pad(day);
            case 'H': return pad(hours);
            case 'M': return pad(minutes);
            case 'S': return pad(seconds);
            case 'a': return weekdays[dayOfWeek];
            case 'b': return months[month];
            case 'j': return pad(getDayOfYear(date, utc), 3);
            case 'n': return '\n';
            case 't': return '\t';
            case '%': return '%';
            default: return `%${code}`;
        }
    });
}

/**
 * Get day of year (1-366)
 */
function getDayOfYear(date: Date, utc: boolean): number {
    const start = new Date(utc ? date.getUTCFullYear() : date.getFullYear(), 0, 0);
    const diff = date.getTime() - start.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
}
