/**
 * Shell Path Utilities
 *
 * Re-exports from /lib/path for shell commands.
 * Kept for backwards compatibility.
 */

export {
    basename,
    dirname,
    join as joinPath,
    isAbsolute,
    normalize,
    resolve,
    resolvePath,
    resolveWithHome as resolvePathWithHome,
    expandHome,
    relative,
    extname,
    parse,
    format,
    type ParsedPath,
} from '/lib/path';
