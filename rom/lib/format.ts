/**
 * Formatting Library for VFS Scripts
 *
 * Date formatting (date-fns style), duration parsing (ms style),
 * and string utilities (slugify). Pure functions, no I/O.
 */

// ============================================================================
// Date Formatting (date-fns inspired)
// ============================================================================

/**
 * Format a date using format tokens.
 *
 *     formatDate(new Date(), 'yyyy-MM-dd')           // '2024-01-15'
 *     formatDate(new Date(), 'HH:mm:ss')             // '14:30:00'
 *     formatDate(new Date(), 'MMM d, yyyy h:mm a')   // 'Jan 15, 2024 2:30 PM'
 *
 * Supported tokens:
 *   yyyy - 4-digit year
 *   yy   - 2-digit year
 *   MM   - 2-digit month (01-12)
 *   M    - month (1-12)
 *   MMM  - short month name (Jan, Feb, ...)
 *   MMMM - full month name (January, February, ...)
 *   dd   - 2-digit day (01-31)
 *   d    - day (1-31)
 *   EEE  - short weekday (Mon, Tue, ...)
 *   EEEE - full weekday (Monday, Tuesday, ...)
 *   HH   - 2-digit hour 24h (00-23)
 *   H    - hour 24h (0-23)
 *   hh   - 2-digit hour 12h (01-12)
 *   h    - hour 12h (1-12)
 *   mm   - 2-digit minute (00-59)
 *   m    - minute (0-59)
 *   ss   - 2-digit second (00-59)
 *   s    - second (0-59)
 *   SSS  - milliseconds (000-999)
 *   a    - AM/PM
 *   X    - timezone offset (+00, +0000, or Z)
 *   x    - timezone offset (+00, +0000)
 */
export function formatDate(date: Date | number, format: string): string {
    const d = typeof date === 'number' ? new Date(date) : date;

    const tokens: Record<string, () => string> = {
        'yyyy': () => String(d.getFullYear()),
        'yy': () => String(d.getFullYear()).slice(-2),
        'MMMM': () => MONTHS_FULL[d.getMonth()] ?? '',
        'MMM': () => MONTHS_SHORT[d.getMonth()] ?? '',
        'MM': () => pad(d.getMonth() + 1),
        'M': () => String(d.getMonth() + 1),
        'dd': () => pad(d.getDate()),
        'd': () => String(d.getDate()),
        'EEEE': () => DAYS_FULL[d.getDay()] ?? '',
        'EEE': () => DAYS_SHORT[d.getDay()] ?? '',
        'HH': () => pad(d.getHours()),
        'H': () => String(d.getHours()),
        'hh': () => pad(d.getHours() % 12 || 12),
        'h': () => String(d.getHours() % 12 || 12),
        'mm': () => pad(d.getMinutes()),
        'm': () => String(d.getMinutes()),
        'ss': () => pad(d.getSeconds()),
        's': () => String(d.getSeconds()),
        'SSS': () => pad(d.getMilliseconds(), 3),
        'a': () => d.getHours() < 12 ? 'AM' : 'PM',
        'X': () => formatTimezone(d, true),
        'x': () => formatTimezone(d, false),
    };

    // Sort tokens by length (longest first) to match correctly
    const tokenRegex = new RegExp(
        Object.keys(tokens).sort((a, b) => b.length - a.length).join('|'),
        'g',
    );

    return format.replace(tokenRegex, match => tokens[match]?.() ?? match);
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(n: number, width: number = 2): string {
    return String(n).padStart(width, '0');
}

function formatTimezone(d: Date, allowZ: boolean): string {
    const offset = -d.getTimezoneOffset();

    if (allowZ && offset === 0) {
        return 'Z';
    }

    const sign = offset >= 0 ? '+' : '-';
    const hours = pad(Math.floor(Math.abs(offset) / 60));
    const mins = pad(Math.abs(offset) % 60);

    return `${sign}${hours}:${mins}`;
}

/**
 * Parse a date string in ISO 8601 format.
 */
export function parseDate(str: string): Date | null {
    const d = new Date(str);

    return isNaN(d.getTime()) ? null : d;
}

/**
 * Add time to a date.
 *
 *     addTime(new Date(), { days: 1, hours: 2 })
 */
export function addTime(date: Date | number, delta: TimeDelta): Date {
    const d = typeof date === 'number' ? new Date(date) : new Date(date.getTime());

    if (delta.years) {
        d.setFullYear(d.getFullYear() + delta.years);
    }

    if (delta.months) {
        d.setMonth(d.getMonth() + delta.months);
    }

    if (delta.days) {
        d.setDate(d.getDate() + delta.days);
    }

    if (delta.hours) {
        d.setHours(d.getHours() + delta.hours);
    }

    if (delta.minutes) {
        d.setMinutes(d.getMinutes() + delta.minutes);
    }

    if (delta.seconds) {
        d.setSeconds(d.getSeconds() + delta.seconds);
    }

    if (delta.milliseconds) {
        d.setMilliseconds(d.getMilliseconds() + delta.milliseconds);
    }

    return d;
}

export interface TimeDelta {
    years?: number;
    months?: number;
    days?: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
    milliseconds?: number;
}

/**
 * Get difference between two dates.
 */
export function diffTime(a: Date | number, b: Date | number): number {
    const aTime = typeof a === 'number' ? a : a.getTime();
    const bTime = typeof b === 'number' ? b : b.getTime();

    return aTime - bTime;
}

/**
 * Check if a date is before another.
 */
export function isBefore(date: Date | number, other: Date | number): boolean {
    return diffTime(date, other) < 0;
}

/**
 * Check if a date is after another.
 */
export function isAfter(date: Date | number, other: Date | number): boolean {
    return diffTime(date, other) > 0;
}

/**
 * Get start of a time unit.
 *
 *     startOf(new Date(), 'day')    // midnight today
 *     startOf(new Date(), 'month')  // first of month
 */
export function startOf(date: Date | number, unit: 'year' | 'month' | 'day' | 'hour' | 'minute'): Date {
    const d = typeof date === 'number' ? new Date(date) : new Date(date.getTime());

    switch (unit) {
        case 'year':
            d.setMonth(0, 1);
            d.setHours(0, 0, 0, 0);
            break;
        case 'month':
            d.setDate(1);
            d.setHours(0, 0, 0, 0);
            break;
        case 'day':
            d.setHours(0, 0, 0, 0);
            break;
        case 'hour':
            d.setMinutes(0, 0, 0);
            break;
        case 'minute':
            d.setSeconds(0, 0);
            break;
    }

    return d;
}

// ============================================================================
// Duration Parsing (ms inspired)
// ============================================================================

/**
 * Parse a duration string to milliseconds.
 *
 *     ms('1d')      // 86400000
 *     ms('2h')      // 7200000
 *     ms('30m')     // 1800000
 *     ms('10s')     // 10000
 *     ms('500ms')   // 500
 *     ms('1d 2h')   // 93600000
 */
export function ms(str: string): number {
    let total = 0;
    const regex = /(-?\d+\.?\d*)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|years?)?/gi;

    let match: RegExpExecArray | null;

    while ((match = regex.exec(str)) !== null) {
        const matchValue = match[1];

        if (matchValue === undefined) {
            continue;
        }

        const value = parseFloat(matchValue);
        const unit = (match[2] || 'ms').toLowerCase();

        total += value * (DURATION_UNITS[unit] ?? 1);
    }

    return total;
}

const DURATION_UNITS: Record<string, number> = {
    ms: 1,
    millisecond: 1,
    milliseconds: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    w: 604_800_000,
    week: 604_800_000,
    weeks: 604_800_000,
    y: 31_536_000_000,
    year: 31_536_000_000,
    years: 31_536_000_000,
};

/**
 * Format milliseconds as a human-readable duration.
 *
 *     formatMs(86400000)        // '1d'
 *     formatMs(93600000, true)  // '1 day 2 hours'
 */
export function formatMs(milliseconds: number, long: boolean = false): string {
    const abs = Math.abs(milliseconds);
    const sign = milliseconds < 0 ? '-' : '';

    if (long) {
        return sign + formatMsLong(abs);
    }

    if (abs >= 86_400_000) {
        return sign + Math.round(abs / 86_400_000) + 'd';
    }

    if (abs >= 3_600_000) {
        return sign + Math.round(abs / 3_600_000) + 'h';
    }

    if (abs >= 60_000) {
        return sign + Math.round(abs / 60_000) + 'm';
    }

    if (abs >= 1000) {
        return sign + Math.round(abs / 1000) + 's';
    }

    return sign + abs + 'ms';
}

function formatMsLong(ms: number): string {
    const parts: string[] = [];

    const days = Math.floor(ms / 86_400_000);

    if (days > 0) {
        parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
        ms %= 86_400_000;
    }

    const hours = Math.floor(ms / 3_600_000);

    if (hours > 0) {
        parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
        ms %= 3_600_000;
    }

    const minutes = Math.floor(ms / 60_000);

    if (minutes > 0) {
        parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
        ms %= 60_000;
    }

    const seconds = Math.floor(ms / 1000);

    if (seconds > 0) {
        parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
        ms %= 1000;
    }

    if (ms > 0 || parts.length === 0) {
        parts.push(`${ms} ${ms === 1 ? 'millisecond' : 'milliseconds'}`);
    }

    return parts.join(' ');
}

// ============================================================================
// String Formatting
// ============================================================================

/**
 * Convert string to URL-safe slug.
 *
 *     slugify('Hello World!')     // 'hello-world'
 *     slugify('Café Münchën')     // 'cafe-munchen'
 */
export function slugify(str: string, options: SlugifyOptions = {}): string {
    const { separator = '-', lowercase = true, strict = false } = options;

    let result = str
        // Normalize unicode (NFD separates accents from letters)
        .normalize('NFD')
        // Remove combining diacritical marks (accents)
        .replace(/[\u0300-\u036f]/g, '')
        // Replace spaces and underscores with separator
        .replace(/[\s_]+/g, separator)
        // Remove non-alphanumeric characters (except separator)
        .replace(new RegExp(`[^a-zA-Z0-9${escapeRegex(separator)}]`, 'g'), strict ? '' : separator)
        // Collapse multiple separators
        .replace(new RegExp(`${escapeRegex(separator)}+`, 'g'), separator)
        // Trim separators from ends
        .replace(new RegExp(`^${escapeRegex(separator)}|${escapeRegex(separator)}$`, 'g'), '');

    if (lowercase) {
        result = result.toLowerCase();
    }

    return result;
}

export interface SlugifyOptions {
    /** Separator character (default: '-') */
    separator?: string;
    /** Convert to lowercase (default: true) */
    lowercase?: boolean;
    /** Remove all non-alphanumeric characters (default: false) */
    strict?: boolean;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Capitalize the first letter of a string.
 */
export function capitalize(str: string): string {
    if (str.length === 0) {
        return str;
    }

    const firstChar = str[0];

    if (firstChar === undefined) {
        return str;
    }

    return firstChar.toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Convert string to camelCase.
 *
 *     camelCase('hello-world')  // 'helloWorld'
 *     camelCase('hello_world')  // 'helloWorld'
 */
export function camelCase(str: string): string {
    return str
        .replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '')
        .replace(/^./, c => c.toLowerCase());
}

/**
 * Convert string to snake_case.
 *
 *     snakeCase('helloWorld')   // 'hello_world'
 *     snakeCase('hello-world')  // 'hello_world'
 */
export function snakeCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase();
}

/**
 * Convert string to kebab-case.
 *
 *     kebabCase('helloWorld')   // 'hello-world'
 *     kebabCase('hello_world')  // 'hello-world'
 */
export function kebabCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

/**
 * Truncate string to max length, adding ellipsis if needed.
 *
 *     truncate('Hello World', 8)         // 'Hello...'
 *     truncate('Hello World', 8, '…')    // 'Hello W…'
 */
export function truncate(str: string, maxLength: number, ellipsis: string = '...'): string {
    if (str.length <= maxLength) {
        return str;
    }

    return str.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Pad start of string to target length.
 */
export function padStart(str: string, length: number, char: string = ' '): string {
    return str.padStart(length, char);
}

/**
 * Pad end of string to target length.
 */
export function padEnd(str: string, length: number, char: string = ' '): string {
    return str.padEnd(length, char);
}

// ============================================================================
// Byte/Size Formatting
// ============================================================================

/**
 * Format bytes as human-readable string.
 *
 *     formatBytes(1536)      // '1.5 KB'
 *     formatBytes(1536000)   // '1.5 MB'
 *     formatBytes(1024)      // '1 KB'
 */
export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let size = Math.abs(bytes);
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    const formatted = unitIndex === 0
        ? String(size)
        : size.toFixed(size < 10 ? 1 : 0);

    return `${bytes < 0 ? '-' : ''}${formatted} ${units[unitIndex]}`;
}

/**
 * Format size with optional human-readable mode.
 *
 *     formatSize(1024, false)     // '    1024'
 *     formatSize(1024, true)      // '  1.0K'
 *     formatSize(1536000, true)   // '  1.5M'
 */
export function formatSize(bytes: number, human: boolean, padWidth: number = 8): string {
    if (!human) {
        return String(bytes).padStart(padWidth);
    }

    const units = ['', 'K', 'M', 'G', 'T', 'P'];
    let size = Math.abs(bytes);
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    const formatted = unitIndex === 0
        ? String(size)
        : size.toFixed(size < 10 ? 1 : 0);

    return (formatted + units[unitIndex]).padStart(padWidth - 2);
}

/**
 * Format file mode as permission string (e.g., drwxr-xr-x).
 *
 *     formatMode('directory', 0o755)  // 'drwxr-xr-x'
 *     formatMode('file', 0o644)       // '-rw-r--r--'
 */
export function formatMode(type: string, mode: number): string {
    const typeChar = type === 'directory' ? 'd'
        : type === 'symlink' ? 'l'
            : type === 'device' ? 'c'
                : '-';

    const perms = [
        (mode & 0o400) ? 'r' : '-',
        (mode & 0o200) ? 'w' : '-',
        (mode & 0o100) ? 'x' : '-',
        (mode & 0o040) ? 'r' : '-',
        (mode & 0o020) ? 'w' : '-',
        (mode & 0o010) ? 'x' : '-',
        (mode & 0o004) ? 'r' : '-',
        (mode & 0o002) ? 'w' : '-',
        (mode & 0o001) ? 'x' : '-',
    ].join('');

    return typeChar + perms;
}

/**
 * Format date for ls-style output.
 * Recent files show "MMM DD HH:MM", older files show "YYYY-MM-DD".
 */
export function formatDateLs(date: Date | undefined): string {
    if (!date) {
        return '          ';
    }

    const now = new Date();
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

    if (date > sixMonthsAgo) {
        // Recent: "Mon DD HH:MM"
        const month = MONTHS_SHORT[date.getMonth()];
        const day = String(date.getDate()).padStart(2);
        const hours = String(date.getHours()).padStart(2, '0');
        const mins = String(date.getMinutes()).padStart(2, '0');

        return `${month} ${day} ${hours}:${mins}`;
    }

    // Older: "YYYY-MM-DD"
    return date.toISOString().slice(0, 10);
}
