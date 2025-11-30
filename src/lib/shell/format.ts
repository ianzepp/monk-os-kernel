/**
 * Shell Formatting Utilities
 *
 * Provides output formatting helpers for shell commands.
 * Ported from src/lib/tty/commands/shared.ts for use in Monk OS binaries.
 */

/**
 * Format file mode as permission string (e.g., drwxr-xr-x)
 *
 * @param type - File type ('directory', 'file', 'symlink', 'device')
 * @param mode - Unix permission bits (e.g., 0o755)
 * @returns Formatted permission string
 *
 * @example
 * formatMode('directory', 0o755)  // 'drwxr-xr-x'
 * formatMode('file', 0o644)       // '-rw-r--r--'
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
 * Format size in human-readable form
 *
 * @param bytes - Size in bytes
 * @param human - Whether to use human-readable format
 * @param padWidth - Width to pad to (default 8)
 * @returns Formatted size string
 *
 * @example
 * formatSize(1024, false)     // '    1024'
 * formatSize(1024, true)      // '  1.0K'
 * formatSize(1536000, true)   // '  1.5M'
 */
export function formatSize(bytes: number, human: boolean, padWidth: number = 8): string {
    if (!human) {
        return String(bytes).padStart(padWidth);
    }

    const units = ['', 'K', 'M', 'G', 'T', 'P'];
    let size = bytes;
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
 * Format a date for ls-style output
 *
 * @param date - Date to format
 * @returns Formatted date string (YYYY-MM-DD or MMM DD HH:MM for recent)
 */
export function formatDate(date: Date | undefined): string {
    if (!date) {
        return '          ';
    }

    const now = new Date();
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

    if (date > sixMonthsAgo) {
        // Recent: "Mon DD HH:MM"
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[date.getMonth()];
        const day = String(date.getDate()).padStart(2);
        const hours = String(date.getHours()).padStart(2, '0');
        const mins = String(date.getMinutes()).padStart(2, '0');
        return `${month} ${day} ${hours}:${mins}`;
    }

    // Older: "Mon DD  YYYY"
    return date.toISOString().slice(0, 10);
}

/**
 * Format bytes as human-readable string (always human-readable)
 *
 * @example
 * formatBytes(1536)     // '1.5 KB'
 * formatBytes(1536000)  // '1.5 MB'
 */
export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    const formatted = unitIndex === 0
        ? String(size)
        : size.toFixed(size < 10 ? 1 : 0);

    return `${formatted} ${units[unitIndex]}`;
}

/**
 * Pad string to width
 */
export function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
    if (align === 'right') {
        return str.padStart(width);
    }
    return str.padEnd(width);
}

/**
 * Truncate string to max length with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
}
