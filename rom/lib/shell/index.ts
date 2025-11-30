/**
 * Shell Library
 *
 * Shared utilities for Monk OS shell commands.
 * These are pure functions with no kernel dependencies.
 */

// Types
export type { ParsedCommand } from './types';

// Argument parsing
export {
    parseArgs,
    parseDuration,
    type ArgSpec,
    type ParsedArgs,
} from './args';

// Path utilities
export {
    resolvePath,
    resolvePathWithHome,
    basename,
    dirname,
    joinPath,
    isAbsolute,
} from './path';

// Formatting utilities
export {
    formatMode,
    formatSize,
    formatDate,
    formatBytes,
    pad,
    truncate,
} from './format';

// Command parsing
export {
    parseCommand,
    expandVariables,
    tokenize,
    findUnquotedChar,
    findUnquotedOperator,
    expandCommandVariables,
    flattenPipeline,
} from './parse';

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
} from './glob';
