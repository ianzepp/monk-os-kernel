/**
 * grep - Search for patterns in files
 *
 * SYNOPSIS
 * ========
 * grep [OPTIONS] PATTERN [FILE]...
 *
 * DESCRIPTION
 * ===========
 * The grep utility searches input files for lines containing a match to the
 * given pattern. By default, grep prints the matching lines.
 *
 * If no files are specified, grep reads from standard input. The pattern is
 * interpreted as a JavaScript regular expression.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: POSIX.1-2017 grep with common GNU extensions
 * Supported flags: -i, -v, -n, -c, -l, -h, -H, -r, -E
 * Unsupported flags: -o, -w, -x, -A, -B, -C (context lines)
 *
 * EXIT CODES
 * ==========
 * 0 - One or more matches found
 * 1 - No matches found
 * 2 - Usage or syntax error
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  consumed - reads item({ text }) messages when no files specified
 * stdout: sends item({ text }) messages - matching lines
 * stderr: item({ text }) - error messages in "grep: message" format
 *
 * @module rom/bin/grep
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    recv,
    send,
    open,
    read,
    close,
    stat,
    readdirAll,
    getcwd,
    println,
    eprintln,
    exit,
    getargs,
    respond,
} from '@rom/lib/process';

import { parseArgs, resolvePath } from '@rom/lib/shell';
import { join } from '@rom/lib/path';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_MATCH = 0;
const EXIT_NO_MATCH = 1;
const EXIT_ERROR = 2;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: grep [OPTIONS] PATTERN [FILE]...

Search for PATTERN in each FILE or standard input.

Options:
  -i, --ignore-case    Ignore case distinctions
  -v, --invert-match   Select non-matching lines
  -n, --line-number    Prefix each line with line number
  -c, --count          Print only count of matching lines
  -l, --files-with-matches  Print only names of files with matches
  -h, --no-filename    Suppress filename prefix
  -H, --with-filename  Print filename for each match
  -r, --recursive      Recursively search directories
  -E, --extended-regexp  Pattern is an extended regex (default)
      --help           Display this help and exit

Examples:
  grep error log.txt           Search for "error" in log.txt
  grep -i TODO *.ts            Case-insensitive search
  grep -rn function src/       Recursive search with line numbers
  grep -v '^#' config          Lines not starting with #
  cat file | grep pattern      Search stdin
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    'ignore-case': { short: 'i', desc: 'Ignore case' },
    'invert-match': { short: 'v', desc: 'Invert match' },
    'line-number': { short: 'n', desc: 'Show line numbers' },
    'count': { short: 'c', desc: 'Count only' },
    'files-with-matches': { short: 'l', desc: 'Files with matches only' },
    'no-filename': { short: 'h', desc: 'No filename prefix' },
    'with-filename': { short: 'H', desc: 'Force filename prefix' },
    'recursive': { short: 'r', desc: 'Recursive search' },
    'extended-regexp': { short: 'E', desc: 'Extended regex (default)' },
    'help': { desc: 'Display help' },
};

// =============================================================================
// TYPES
// =============================================================================

interface GrepOptions {
    ignoreCase: boolean;
    invertMatch: boolean;
    lineNumber: boolean;
    countOnly: boolean;
    filesOnly: boolean;
    noFilename: boolean;
    withFilename: boolean;
    recursive: boolean;
}

interface GrepResult {
    matchCount: number;
    hadError: boolean;
}

// =============================================================================
// CORE GREP LOGIC
// =============================================================================

/**
 * Search a single file for pattern matches.
 */
async function grepFile(
    path: string,
    displayName: string,
    regex: RegExp,
    opts: GrepOptions,
    showFilename: boolean,
): Promise<GrepResult> {
    let matchCount = 0;
    let hadError = false;

    try {
        const fd = await open(path, { read: true });

        try {
            const decoder = new TextDecoder('utf-8', { fatal: false });
            let buffer = '';
            let lineNum = 0;

            for await (const chunk of read(fd)) {
                buffer += decoder.decode(chunk, { stream: true });

                const lines = buffer.split('\n');
                const remaining = lines.pop();
                buffer = remaining ?? '';

                for (const line of lines) {
                    lineNum++;
                    const matches = regex.test(line);
                    const shouldOutput = opts.invertMatch ? !matches : matches;

                    if (shouldOutput) {
                        matchCount++;

                        if (!opts.countOnly && !opts.filesOnly) {
                            let output = line;

                            if (opts.lineNumber) {
                                output = `${lineNum}:${output}`;
                            }

                            if (showFilename) {
                                output = `${displayName}:${output}`;
                            }

                            await println(output);
                        }
                    }
                }
            }

            // Flush remaining buffer
            buffer += decoder.decode();
            if (buffer.length > 0) {
                lineNum++;
                const matches = regex.test(buffer);
                const shouldOutput = opts.invertMatch ? !matches : matches;

                if (shouldOutput) {
                    matchCount++;

                    if (!opts.countOnly && !opts.filesOnly) {
                        let output = buffer;

                        if (opts.lineNumber) {
                            output = `${lineNum}:${output}`;
                        }

                        if (showFilename) {
                            output = `${displayName}:${output}`;
                        }

                        await println(output);
                    }
                }
            }
        }
        finally {
            await close(fd);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grep: ${displayName}: ${msg}`);
        hadError = true;
    }

    // Output for -c and -l modes
    if (opts.filesOnly && matchCount > 0) {
        await println(displayName);
    }
    else if (opts.countOnly) {
        if (showFilename) {
            await println(`${displayName}:${matchCount}`);
        }
        else {
            await println(String(matchCount));
        }
    }

    return { matchCount, hadError };
}

/**
 * Search stdin for pattern matches.
 */
async function grepStdin(
    regex: RegExp,
    opts: GrepOptions,
): Promise<GrepResult> {
    let matchCount = 0;
    let lineNum = 0;

    for await (const msg of recv(0)) {
        if (msg.op === 'item' && msg.data) {
            const data = msg.data as { text?: string };
            if (data.text) {
                // Split on newlines in case text contains multiple lines
                const lines = data.text.split('\n');

                for (const line of lines) {
                    if (line.length === 0 && lines.length > 1) continue;

                    lineNum++;
                    const matches = regex.test(line);
                    const shouldOutput = opts.invertMatch ? !matches : matches;

                    if (shouldOutput) {
                        matchCount++;

                        if (!opts.countOnly) {
                            let output = line;

                            if (opts.lineNumber) {
                                output = `${lineNum}:${output}`;
                            }

                            await println(output);
                        }
                    }
                }
            }
        }
        else if (msg.op === 'done' || msg.op === 'ok' || msg.op === 'error') {
            break;
        }
    }

    if (opts.countOnly) {
        await println(String(matchCount));
    }

    return { matchCount, hadError: false };
}

/**
 * Recursively collect files from a directory.
 */
async function collectFiles(path: string, cwd: string): Promise<string[]> {
    const files: string[] = [];

    try {
        const entries = await readdirAll(path);

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;

            const fullPath = join(path, entry.name);

            if (entry.model === 'folder') {
                const subFiles = await collectFiles(fullPath, cwd);
                files.push(...subFiles);
            }
            else if (entry.model === 'file') {
                files.push(fullPath);
            }
        }
    }
    catch {
        // Ignore directories we can't read
    }

    return files;
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    // Handle parse errors
    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            await eprintln(`grep: ${err}`);
        }
        return exit(EXIT_ERROR);
    }

    // Handle unknown flags
    if (parsed.unknown.length > 0) {
        for (const flag of parsed.unknown) {
            await eprintln(`grep: unknown option: ${flag}`);
        }
        return exit(EXIT_ERROR);
    }

    // Help
    if (parsed.flags.help) {
        await println(HELP_TEXT);
        return exit(EXIT_MATCH);
    }

    // Need at least a pattern
    if (parsed.positional.length < 1) {
        await eprintln('grep: missing pattern');
        await eprintln("Try 'grep --help' for more information.");
        return exit(EXIT_ERROR);
    }

    // Build options
    const opts: GrepOptions = {
        ignoreCase: Boolean(parsed.flags['ignore-case']),
        invertMatch: Boolean(parsed.flags['invert-match']),
        lineNumber: Boolean(parsed.flags['line-number']),
        countOnly: Boolean(parsed.flags['count']),
        filesOnly: Boolean(parsed.flags['files-with-matches']),
        noFilename: Boolean(parsed.flags['no-filename']),
        withFilename: Boolean(parsed.flags['with-filename']),
        recursive: Boolean(parsed.flags['recursive']),
    };

    // Build regex
    const pattern = parsed.positional[0]!;
    let regex: RegExp;

    try {
        const flags = opts.ignoreCase ? 'i' : '';
        regex = new RegExp(pattern, flags);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grep: invalid pattern: ${msg}`);
        return exit(EXIT_ERROR);
    }

    // Get files to search
    const fileArgs = parsed.positional.slice(1);
    const cwd = await getcwd();

    let totalMatches = 0;
    let hadError = false;

    // Stdin mode
    if (fileArgs.length === 0) {
        const result = await grepStdin(regex, opts);
        totalMatches = result.matchCount;
        await send(1, respond.done());
        return exit(totalMatches > 0 ? EXIT_MATCH : EXIT_NO_MATCH);
    }

    // File mode - collect all files (expanding directories if -r)
    const filesToSearch: Array<{ path: string; displayName: string }> = [];

    for (const fileArg of fileArgs) {
        const resolved = resolvePath(cwd, fileArg);

        try {
            const info = await stat(resolved);

            if (info.model === 'folder') {
                if (opts.recursive) {
                    const subFiles = await collectFiles(resolved, cwd);
                    for (const f of subFiles) {
                        filesToSearch.push({ path: f, displayName: f });
                    }
                }
                else {
                    await eprintln(`grep: ${fileArg}: Is a directory`);
                    hadError = true;
                }
            }
            else {
                filesToSearch.push({ path: resolved, displayName: fileArg });
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`grep: ${fileArg}: ${msg}`);
            hadError = true;
        }
    }

    // Determine if we should show filenames
    const multipleFiles = filesToSearch.length > 1;
    const showFilename = opts.withFilename || (multipleFiles && !opts.noFilename);

    // Search each file
    for (const { path, displayName } of filesToSearch) {
        const result = await grepFile(path, displayName, regex, opts, showFilename);
        totalMatches += result.matchCount;
        if (result.hadError) hadError = true;
    }

    await send(1, respond.done());

    // Exit code: 0 if matches found, 1 if no matches, 2 if error
    if (hadError && totalMatches === 0) {
        return exit(EXIT_ERROR);
    }

    return exit(totalMatches > 0 ? EXIT_MATCH : EXIT_NO_MATCH);
}
