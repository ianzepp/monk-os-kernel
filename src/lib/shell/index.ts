/**
 * Shell Library
 *
 * Shared utilities for Monk OS shell commands.
 * These are pure functions with no kernel dependencies.
 */

// Argument parsing
export {
    parseArgs,
    parseDuration,
    type ArgSpec,
    type ParsedArgs,
} from './args.js';

// Path utilities
export {
    resolvePath,
    resolvePathWithHome,
    basename,
    dirname,
    joinPath,
    isAbsolute,
} from './path.js';

// Formatting utilities
export {
    formatMode,
    formatSize,
    formatDate,
    formatBytes,
    pad,
    truncate,
} from './format.js';
