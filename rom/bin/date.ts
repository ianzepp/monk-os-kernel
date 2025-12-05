/**
 * date - display date and time
 *
 * Usage: date [OPTIONS] [+FORMAT]
 *
 * Options:
 *   -u   Display UTC time
 *   -I   Display ISO 8601 format
 *
 * Format specifiers (with +FORMAT):
 *   %Y   4-digit year
 *   %y   2-digit year
 *   %m   Month (01-12)
 *   %d   Day (01-31)
 *   %H   Hour 24h (00-23)
 *   %M   Minute (00-59)
 *   %S   Second (00-59)
 *   %a   Short weekday (Sun, Mon, ...)
 *   %b   Short month (Jan, Feb, ...)
 *   %j   Day of year (001-366)
 *   %n   Newline
 *   %t   Tab
 *   %%   Literal %
 *
 * Examples:
 *   date
 *   date -u
 *   date +%Y-%m-%d
 *   date "+%Y-%m-%d %H:%M:%S"
 */

import { getargs, println, exit } from '@os/process';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);
    const now = new Date();

    // Parse options
    const utc = argv.includes('-u') || argv.includes('--utc');
    const iso = argv.includes('-I') || argv.includes('--iso-8601');
    const formatArg = argv.find(a => a.startsWith('+'));

    if (iso) {
        await println(now.toISOString());
        await exit(0);
    }

    if (formatArg) {
        const format = formatArg.slice(1);
        const result = formatDate(now, format, utc);

        await println(result);
        await exit(0);
    }

    // Default format like Unix date
    if (utc) {
        await println(now.toUTCString());
    }
    else {
        await println(now.toString());
    }

    await exit(0);
}

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

    return format.replace(/%(.)/g, (_match, code: string) => {
        switch (code) {
            case 'Y': return String(year);
            case 'y': return String(year).slice(-2);
            case 'm': return pad(month + 1);
            case 'd': return pad(day);
            case 'H': return pad(hours);
            case 'M': return pad(minutes);
            case 'S': return pad(seconds);
            case 'a': {
                const weekday = WEEKDAYS[dayOfWeek];

                return weekday !== undefined ? weekday : '';
            }

            case 'b': {
                const monthName = MONTHS[month];

                return monthName !== undefined ? monthName : '';
            }

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

main().catch(async () => {
    await exit(1);
});
