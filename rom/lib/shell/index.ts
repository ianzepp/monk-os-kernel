/**
 * Shell Library
 *
 * Shell-specific utilities for Monk OS.
 * For general utilities, use /lib/* directly.
 */

// Types
export type { ParsedCommand } from './types';

// Glob expansion (fs-integrated)
export {
    expandGlobs,
    expandGlob,
    type GlobEntry,
    type ReaddirFn,
} from './glob';

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
