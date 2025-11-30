/**
 * grep - Search for patterns in input
 *
 * Usage:
 *   grep [options] <pattern> [file...]
 *   <input> | grep [options] <pattern>
 *
 * Options:
 *   -i              Case-insensitive match
 *   -v              Invert match (show non-matching lines)
 *   -c              Count matching lines only
 *   -n              Show line numbers
 *   -l              Show only filenames with matches
 *   -h              Suppress filename prefix
 *   -o              Show only matching part of line
 *   -E              Extended regex (default)
 *   -F              Fixed strings (literal match, no regex)
 *   -w              Match whole words only
 *   -x              Match whole lines only
 *   -q              Quiet mode (exit status only)
 *   -m <num>        Stop after num matches
 *   -A <num>        Show num lines after match
 *   -B <num>        Show num lines before match
 *   -C <num>        Show num lines before and after (context)
 *
 * Examples:
 *   find . | grep users              Find paths containing "users"
 *   ls -l | grep -i json             Case-insensitive search
 *   cat file | grep -v test          Exclude lines with "test"
 *   grep -n error /var/log/app.log   Show line numbers
 *   grep -c TODO *.ts                Count matches per file
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    ignoreCase: { short: 'i', desc: 'Case-insensitive' },
    invert: { short: 'v', desc: 'Invert match' },
    count: { short: 'c', desc: 'Count only' },
    lineNumber: { short: 'n', desc: 'Show line numbers' },
    filesOnly: { short: 'l', desc: 'Filenames only' },
    noFilename: { short: 'h', desc: 'Suppress filename' },
    onlyMatching: { short: 'o', desc: 'Only matching part' },
    extended: { short: 'E', desc: 'Extended regex' },
    fixed: { short: 'F', desc: 'Fixed strings' },
    word: { short: 'w', desc: 'Whole words' },
    line: { short: 'x', desc: 'Whole lines' },
    quiet: { short: 'q', desc: 'Quiet mode' },
    maxCount: { short: 'm', value: true, desc: 'Max matches' },
    after: { short: 'A', value: true, desc: 'Lines after' },
    before: { short: 'B', value: true, desc: 'Lines before' },
    context: { short: 'C', value: true, desc: 'Context lines' },
};

type GrepOptions = {
    ignoreCase: boolean;
    invert: boolean;
    count: boolean;
    lineNumber: boolean;
    filesOnly: boolean;
    noFilename: boolean;
    onlyMatching: boolean;
    fixed: boolean;
    word: boolean;
    line: boolean;
    quiet: boolean;
    maxCount: number | null;
    after: number;
    before: number;
};

/**
 * Build regex from pattern and options
 */
function buildPattern(pattern: string, options: GrepOptions): RegExp | null {
    try {
        let regexStr = pattern;

        if (options.fixed) {
            // Escape regex special characters for literal match
            regexStr = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        if (options.word) {
            regexStr = `\\b${regexStr}\\b`;
        }

        if (options.line) {
            regexStr = `^${regexStr}$`;
        }

        const flags = options.ignoreCase ? 'gi' : 'g';
        return new RegExp(regexStr, flags);
    } catch {
        return null;
    }
}

/**
 * Process lines and output matches
 */
function processLines(
    lines: string[],
    regex: RegExp,
    options: GrepOptions,
    filename: string | null,
    showFilename: boolean,
    io: { stdout: { write: (s: string) => void } }
): { matchCount: number; fileMatched: boolean } {
    let matchCount = 0;
    let fileMatched = false;
    const contextBefore: string[] = [];
    let contextAfterRemaining = 0;
    let lastPrintedLine = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        regex.lastIndex = 0; // Reset for global regex
        const matches = regex.test(line);
        const shouldOutput = options.invert ? !matches : matches;

        // Handle context after previous match
        if (contextAfterRemaining > 0 && !shouldOutput) {
            if (!options.quiet && !options.count && !options.filesOnly) {
                outputLine(i, line, filename, showFilename, options, io, false);
                lastPrintedLine = i;
            }
            contextAfterRemaining--;
        }

        if (shouldOutput) {
            matchCount++;
            fileMatched = true;

            if (options.quiet) {
                return { matchCount: 1, fileMatched: true };
            }

            if (options.filesOnly) {
                return { matchCount: 1, fileMatched: true };
            }

            if (!options.count) {
                // Print context before
                if (options.before > 0) {
                    for (let j = 0; j < contextBefore.length; j++) {
                        const ctxLineNum = i - contextBefore.length + j;
                        if (ctxLineNum > lastPrintedLine) {
                            outputLine(ctxLineNum, contextBefore[j], filename, showFilename, options, io, false);
                        }
                    }
                }

                // Print matching line
                if (options.onlyMatching) {
                    regex.lastIndex = 0;
                    let match;
                    while ((match = regex.exec(line)) !== null) {
                        const prefix = buildPrefix(i, filename, showFilename, options);
                        io.stdout.write(prefix + match[0] + '\n');
                    }
                } else {
                    outputLine(i, line, filename, showFilename, options, io, true);
                }
                lastPrintedLine = i;
                contextAfterRemaining = options.after;
            }

            if (options.maxCount !== null && matchCount >= options.maxCount) {
                break;
            }
        }

        // Track context before
        if (options.before > 0) {
            contextBefore.push(line);
            if (contextBefore.length > options.before) {
                contextBefore.shift();
            }
        }
    }

    return { matchCount, fileMatched };
}

/**
 * Build line prefix (filename, line number)
 */
function buildPrefix(
    lineNum: number,
    filename: string | null,
    showFilename: boolean,
    options: GrepOptions
): string {
    let prefix = '';
    if (showFilename && filename && !options.noFilename) {
        prefix += filename + ':';
    }
    if (options.lineNumber) {
        prefix += (lineNum + 1) + ':';
    }
    return prefix;
}

/**
 * Output a single line with prefix
 */
function outputLine(
    lineNum: number,
    line: string,
    filename: string | null,
    showFilename: boolean,
    options: GrepOptions,
    io: { stdout: { write: (s: string) => void } },
    _isMatch: boolean
): void {
    const prefix = buildPrefix(lineNum, filename, showFilename, options);
    io.stdout.write(prefix + line + '\n');
}

export const grep: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`grep: ${err}\n`);
        }
        return 1;
    }

    if (parsed.positional.length === 0) {
        io.stderr.write('grep: missing pattern\n');
        io.stderr.write('Usage: grep [options] <pattern> [file...]\n');
        return 1;
    }

    const pattern = parsed.positional[0];
    const files = parsed.positional.slice(1);

    // Parse context option (overrides -A and -B)
    let after = 0;
    let before = 0;
    if (typeof parsed.flags.context === 'string') {
        const ctx = parseInt(parsed.flags.context, 10);
        if (!isNaN(ctx)) {
            after = ctx;
            before = ctx;
        }
    }
    if (typeof parsed.flags.after === 'string') {
        const a = parseInt(parsed.flags.after, 10);
        if (!isNaN(a)) after = a;
    }
    if (typeof parsed.flags.before === 'string') {
        const b = parseInt(parsed.flags.before, 10);
        if (!isNaN(b)) before = b;
    }

    const options: GrepOptions = {
        ignoreCase: Boolean(parsed.flags.ignoreCase),
        invert: Boolean(parsed.flags.invert),
        count: Boolean(parsed.flags.count),
        lineNumber: Boolean(parsed.flags.lineNumber),
        filesOnly: Boolean(parsed.flags.filesOnly),
        noFilename: Boolean(parsed.flags.noFilename),
        onlyMatching: Boolean(parsed.flags.onlyMatching),
        fixed: Boolean(parsed.flags.fixed),
        word: Boolean(parsed.flags.word),
        line: Boolean(parsed.flags.line),
        quiet: Boolean(parsed.flags.quiet),
        maxCount: typeof parsed.flags.maxCount === 'string'
            ? parseInt(parsed.flags.maxCount, 10)
            : null,
        after,
        before,
    };

    const regex = buildPattern(pattern, options);
    if (!regex) {
        io.stderr.write(`grep: invalid pattern: ${pattern}\n`);
        return 1;
    }

    // Reading from files or stdin?
    if (files.length === 0) {
        // Read from stdin
        let buffer = '';
        for await (const chunk of io.stdin) {
            buffer += chunk.toString();
        }

        const lines = buffer.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();

        const { matchCount, fileMatched } = processLines(
            lines, regex, options, null, false, io
        );

        if (options.count) {
            io.stdout.write(matchCount + '\n');
        }

        return fileMatched ? 0 : 1;
    }

    // Process files
    const showFilename = files.length > 1 && !options.noFilename;
    let anyMatch = false;

    for (const file of files) {
        const resolved = resolvePath(session.cwd, file);

        try {
            const data = await fs!.read(resolved);
            const content = data.toString();
            const lines = content.split('\n');
            if (lines[lines.length - 1] === '') lines.pop();

            const { matchCount, fileMatched } = processLines(
                lines, regex, options, file, showFilename, io
            );

            if (fileMatched) {
                anyMatch = true;
                if (options.filesOnly) {
                    io.stdout.write(file + '\n');
                }
            }

            if (options.count) {
                const prefix = showFilename ? file + ':' : '';
                io.stdout.write(prefix + matchCount + '\n');
            }

            if (options.quiet && anyMatch) {
                return 0;
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`grep: ${file}: ${err.message}\n`);
            }
        }
    }

    return anyMatch ? 0 : 1;
};
