/**
 * Shell Library
 *
 * Shared utilities for Monk OS shell commands.
 * These are pure functions with no kernel dependencies.
 */

// Types
export type { ParsedCommand } from './types.js';

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

// Command parsing
export {
    parseCommand,
    expandVariables,
    tokenize,
    findUnquotedChar,
    findUnquotedOperator,
    expandCommandVariables,
    flattenPipeline,
} from './parse.js';

// Glob expansion
export {
    hasGlobChars,
    globToRegex,
    matchGlob,
    expandGlobs,
    expandGlob,
    pathMatchesGlob,
    type GlobEntry,
    type ReaddirFn,
} from './glob.js';
