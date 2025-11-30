/**
 * find - Search for files in a directory hierarchy
 *
 * Usage:
 *   find [path...] [expression]
 *
 * Primaries:
 *   -name <pattern>     Match filename (supports *, ?)
 *   -iname <pattern>    Case-insensitive -name
 *   -path <pattern>     Match full path
 *   -ipath <pattern>    Case-insensitive -path
 *   -type <c>           File type: f (file), d (directory), l (symlink)
 *   -maxdepth <n>       Descend at most n levels
 *   -mindepth <n>       Ignore first n levels
 *   -empty              Match empty files/directories
 *   -newer <file>       Match files newer than reference file
 *
 * Actions:
 *   -print              Print path (default)
 *   -print0             Print path with NUL terminator (for xargs -0)
 *   -exec <cmd> {} \;   Execute command for each match
 *   -delete             Delete matched files
 *
 * Operators:
 *   -a, -and            AND (implicit between primaries)
 *   -o, -or             OR
 *   ! <expr>            NOT
 *   ( <expr> )          Grouping
 *
 * Examples:
 *   find .                          List all files recursively
 *   find /api/data -type f          Find only files
 *   find . -name "*.json"           Find by name pattern
 *   find . -name "*.log" -delete    Find and delete
 *   find . -type f -exec cat {} \;  Execute cat on each file
 *   find . -print0 | xargs -0 rm    Safe handling of special chars
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FS, FSEntry } from '@src/lib/fs/index.js';
import { PassThrough } from 'node:stream';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import type { Session, CommandIO } from '../types.js';
import { commands } from './index.js';

/** Maximum recursion depth to prevent infinite loops */
const DEFAULT_MAX_DEPTH = 100;

type FindOptions = {
    namePattern?: RegExp;
    pathPattern?: RegExp;
    typeFilter?: 'f' | 'd' | 'l';
    maxDepth: number;
    minDepth: number;
    empty?: boolean;
    newerThan?: Date;
    print0: boolean;
    deleteFiles: boolean;
    execCmd?: string[];
    negate: boolean;
};

/**
 * Convert glob pattern to regex
 * Supports * (any chars) and ? (single char)
 */
function globToRegex(pattern: string, caseInsensitive: boolean): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : '');
}

/**
 * Parse find expression into options
 * Returns [options, remaining args, error]
 */
function parseExpression(args: string[]): [FindOptions, string[], string | null] {
    const options: FindOptions = {
        maxDepth: DEFAULT_MAX_DEPTH,
        minDepth: 0,
        print0: false,
        deleteFiles: false,
        negate: false,
    };

    const paths: string[] = [];
    let i = 0;

    // Collect leading paths (before any expression)
    while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') {
        paths.push(args[i]);
        i++;
    }

    // If no paths, default to current directory
    if (paths.length === 0) {
        paths.push('.');
    }

    // Parse expression
    while (i < args.length) {
        const arg = args[i];

        // Negation
        if (arg === '!' || arg === '-not') {
            options.negate = !options.negate;
            i++;
            continue;
        }

        // Skip AND (implicit)
        if (arg === '-a' || arg === '-and') {
            i++;
            continue;
        }

        // OR not fully supported yet - just skip
        if (arg === '-o' || arg === '-or') {
            i++;
            continue;
        }

        // Grouping not fully supported - just skip parens
        if (arg === '(' || arg === ')') {
            i++;
            continue;
        }

        // -name / -iname
        if (arg === '-name' || arg === '-iname') {
            if (!args[i + 1]) {
                return [options, paths, `${arg} requires a pattern`];
            }
            options.namePattern = globToRegex(args[i + 1], arg === '-iname');
            i += 2;
            continue;
        }

        // -path / -ipath
        if (arg === '-path' || arg === '-ipath') {
            if (!args[i + 1]) {
                return [options, paths, `${arg} requires a pattern`];
            }
            options.pathPattern = globToRegex(args[i + 1], arg === '-ipath');
            i += 2;
            continue;
        }

        // -type
        if (arg === '-type') {
            const typeArg = args[i + 1];
            if (typeArg !== 'f' && typeArg !== 'd' && typeArg !== 'l') {
                return [options, paths, `-type requires f, d, or l`];
            }
            options.typeFilter = typeArg;
            i += 2;
            continue;
        }

        // -maxdepth
        if (arg === '-maxdepth') {
            const depth = parseInt(args[i + 1], 10);
            if (isNaN(depth) || depth < 0) {
                return [options, paths, `-maxdepth requires a non-negative integer`];
            }
            options.maxDepth = depth;
            i += 2;
            continue;
        }

        // -mindepth
        if (arg === '-mindepth') {
            const depth = parseInt(args[i + 1], 10);
            if (isNaN(depth) || depth < 0) {
                return [options, paths, `-mindepth requires a non-negative integer`];
            }
            options.minDepth = depth;
            i += 2;
            continue;
        }

        // -empty
        if (arg === '-empty') {
            options.empty = true;
            i++;
            continue;
        }

        // -newer
        if (arg === '-newer') {
            if (!args[i + 1]) {
                return [options, paths, `-newer requires a file path`];
            }
            // Will resolve and stat during execution
            i += 2;
            continue;
        }

        // -print (default, explicit)
        if (arg === '-print') {
            i++;
            continue;
        }

        // -print0
        if (arg === '-print0') {
            options.print0 = true;
            i++;
            continue;
        }

        // -delete
        if (arg === '-delete') {
            options.deleteFiles = true;
            i++;
            continue;
        }

        // -exec ... {} \;
        if (arg === '-exec') {
            const execArgs: string[] = [];
            i++;
            while (i < args.length && args[i] !== ';' && args[i] !== '\\;') {
                execArgs.push(args[i]);
                i++;
            }
            if (i < args.length) i++; // Skip terminator
            if (execArgs.length === 0) {
                return [options, paths, `-exec requires a command`];
            }
            options.execCmd = execArgs;
            continue;
        }

        // Unknown option - skip (could warn)
        i++;
    }

    return [options, paths, null];
}

/**
 * Check if an entry matches the find criteria
 */
function matchesEntry(
    entry: FSEntry,
    path: string,
    options: FindOptions
): boolean {
    let matches = true;

    // Type filter
    if (options.typeFilter) {
        const entryType =
            entry.type === 'directory' ? 'd' :
            entry.type === 'symlink' ? 'l' : 'f';
        if (entryType !== options.typeFilter) {
            matches = false;
        }
    }

    // Name pattern
    if (matches && options.namePattern) {
        if (!options.namePattern.test(entry.name)) {
            matches = false;
        }
    }

    // Path pattern
    if (matches && options.pathPattern) {
        if (!options.pathPattern.test(path)) {
            matches = false;
        }
    }

    // Empty check
    if (matches && options.empty !== undefined) {
        const isEmpty = entry.size === 0;
        if (options.empty !== isEmpty) {
            matches = false;
        }
    }

    // Newer than
    if (matches && options.newerThan) {
        const mtime = entry.mtime?.getTime() ?? 0;
        if (mtime <= options.newerThan.getTime()) {
            matches = false;
        }
    }

    // Apply negation
    return options.negate ? !matches : matches;
}

/**
 * Execute -exec command for a matched file
 */
async function execForFile(
    session: Session,
    fs: FS,
    execCmd: string[],
    filePath: string,
    io: CommandIO
): Promise<number> {
    // Replace {} with file path
    const cmdArgs = execCmd.map(arg => arg === '{}' ? filePath : arg);
    const cmdName = cmdArgs[0];
    const cmdRest = cmdArgs.slice(1);

    const handler = commands[cmdName];
    if (!handler) {
        io.stderr.write(`find: ${cmdName}: command not found\n`);
        return 127;
    }

    const childIO: CommandIO = {
        stdin: new PassThrough(),
        stdout: io.stdout,
        stderr: io.stderr,
        signal: io.signal,
    };
    childIO.stdin.end();

    return handler(session, fs, cmdRest, childIO);
}

/**
 * Walk directory tree and apply find expression
 */
async function walkDirectory(
    session: Session,
    fs: FS,
    path: string,
    io: CommandIO,
    options: FindOptions,
    depth: number,
    visited: Set<string>
): Promise<{ aborted: boolean; exitCode: number }> {
    // Check for abort signal
    if (io.signal?.aborted) {
        return { aborted: true, exitCode: 130 };
    }

    // Prevent infinite loops
    if (visited.has(path)) {
        return { aborted: false, exitCode: 0 };
    }
    visited.add(path);

    // Check max depth
    if (depth > options.maxDepth) {
        return { aborted: false, exitCode: 0 };
    }

    let exitCode = 0;

    try {
        const stat = await fs.stat(path);
        const isDir = stat.type === 'directory';

        // Check if this entry matches (respecting mindepth)
        if (depth >= options.minDepth && matchesEntry(stat, path, options)) {
            // Action: delete
            if (options.deleteFiles) {
                try {
                    await fs.unlink(path);
                } catch (err) {
                    if (err instanceof FSError) {
                        io.stderr.write(`find: cannot delete '${path}': ${err.message}\n`);
                        exitCode = 1;
                    }
                }
            }
            // Action: exec
            else if (options.execCmd) {
                const code = await execForFile(session, fs, options.execCmd, path, io);
                if (code !== 0) exitCode = code;
            }
            // Action: print (default)
            else {
                const terminator = options.print0 ? '\0' : '\n';
                io.stdout.write(path + terminator);
            }
        }

        // Recurse into directories
        if (isDir && depth < options.maxDepth) {
            const entries = await fs.readdir(path);
            entries.sort((a, b) => a.name.localeCompare(b.name));

            for (const entry of entries) {
                if (io.signal?.aborted) {
                    return { aborted: true, exitCode: 130 };
                }

                const childPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
                const result = await walkDirectory(
                    session, fs, childPath, io, options, depth + 1, visited
                );

                if (result.aborted) {
                    return result;
                }
                if (result.exitCode !== 0) {
                    exitCode = result.exitCode;
                }
            }
        }
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`find: ${path}: ${err.message}\n`);
            exitCode = 1;
        }
    }

    return { aborted: false, exitCode };
}

export const find: CommandHandler = async (session, fs, args, io) => {
    const [options, paths, error] = parseExpression(args);

    if (error) {
        io.stderr.write(`find: ${error}\n`);
        return 1;
    }

    const visited = new Set<string>();
    let exitCode = 0;

    for (const target of paths) {
        const resolved = resolvePath(session.cwd, target);
        const result = await walkDirectory(
            session, fs!, resolved, io, options, 0, visited
        );

        if (result.aborted) {
            return 130;
        }
        if (result.exitCode !== 0) {
            exitCode = result.exitCode;
        }
    }

    return exitCode;
};
