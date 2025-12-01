/**
 * Shell Formatting Utilities
 *
 * Re-exports from /lib/format for shell commands.
 * Kept for backwards compatibility.
 */

export {
    formatBytes,
    formatSize,
    formatMode,
    formatDateLs as formatDate,
    truncate,
    padStart as pad,
    padEnd,
} from '/lib/format';
