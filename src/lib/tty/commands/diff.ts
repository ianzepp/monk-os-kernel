/**
 * diff - compare files line by line
 *
 * Usage:
 *   diff [options] <file1> <file2>
 *
 * Options:
 *   -u              Unified format (default)
 *   -c              Context format
 *   -y              Side-by-side format
 *   -q              Report only whether files differ
 *   -s              Report identical files
 *   -i              Ignore case
 *   -w              Ignore all whitespace
 *   -b              Ignore changes in whitespace amount
 *   -B              Ignore blank lines
 *   -U <n>          Lines of context (default 3)
 *   --no-color      Disable colored output
 *
 * Examples:
 *   diff file1 file2              Compare two files
 *   diff -u old.txt new.txt       Unified diff
 *   diff -q config1 config2       Just report if different
 *   diff -i file1 file2           Case-insensitive comparison
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    unified: { short: 'u', desc: 'Unified format' },
    context: { short: 'c', desc: 'Context format' },
    sideBySide: { short: 'y', desc: 'Side-by-side' },
    brief: { short: 'q', desc: 'Brief output' },
    reportSame: { short: 's', desc: 'Report identical' },
    ignoreCase: { short: 'i', desc: 'Ignore case' },
    ignoreAllSpace: { short: 'w', desc: 'Ignore all whitespace' },
    ignoreSpaceChange: { short: 'b', desc: 'Ignore space changes' },
    ignoreBlankLines: { short: 'B', desc: 'Ignore blank lines' },
    contextLines: { short: 'U', value: true, desc: 'Context lines' },
    noColor: { long: 'no-color', desc: 'No colors' },
};

type DiffOptions = {
    unified: boolean;
    context: boolean;
    sideBySide: boolean;
    brief: boolean;
    reportSame: boolean;
    ignoreCase: boolean;
    ignoreAllSpace: boolean;
    ignoreSpaceChange: boolean;
    ignoreBlankLines: boolean;
    contextLines: number;
    noColor: boolean;
};

type DiffOp = 'equal' | 'insert' | 'delete';

type DiffResult = {
    op: DiffOp;
    line1?: number;
    line2?: number;
    text: string;
};

/**
 * Normalize line for comparison based on options
 */
function normalizeLine(line: string, options: DiffOptions): string {
    let result = line;

    if (options.ignoreCase) {
        result = result.toLowerCase();
    }

    if (options.ignoreAllSpace) {
        result = result.replace(/\s+/g, '');
    } else if (options.ignoreSpaceChange) {
        result = result.replace(/\s+/g, ' ').trim();
    }

    return result;
}

/**
 * Compute longest common subsequence table
 */
function computeLCS(
    lines1: string[],
    lines2: string[],
    options: DiffOptions
): number[][] {
    const m = lines1.length;
    const n = lines2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const norm1 = normalizeLine(lines1[i - 1], options);
            const norm2 = normalizeLine(lines2[j - 1], options);

            if (norm1 === norm2) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    return dp;
}

/**
 * Compute diff using LCS
 */
function computeDiff(
    lines1: string[],
    lines2: string[],
    options: DiffOptions
): DiffResult[] {
    // Filter blank lines if needed
    let filtered1 = lines1;
    let filtered2 = lines2;

    if (options.ignoreBlankLines) {
        filtered1 = lines1.filter(l => l.trim() !== '');
        filtered2 = lines2.filter(l => l.trim() !== '');
    }

    const dp = computeLCS(filtered1, filtered2, options);
    const results: DiffResult[] = [];

    let i = filtered1.length;
    let j = filtered2.length;

    // Backtrack to find the diff
    const ops: DiffResult[] = [];

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const norm1 = normalizeLine(filtered1[i - 1], options);
            const norm2 = normalizeLine(filtered2[j - 1], options);

            if (norm1 === norm2) {
                ops.unshift({
                    op: 'equal',
                    line1: i,
                    line2: j,
                    text: lines1[i - 1],
                });
                i--;
                j--;
            } else if (dp[i - 1][j] >= dp[i][j - 1]) {
                ops.unshift({
                    op: 'delete',
                    line1: i,
                    text: lines1[i - 1],
                });
                i--;
            } else {
                ops.unshift({
                    op: 'insert',
                    line2: j,
                    text: lines2[j - 1],
                });
                j--;
            }
        } else if (i > 0) {
            ops.unshift({
                op: 'delete',
                line1: i,
                text: lines1[i - 1],
            });
            i--;
        } else {
            ops.unshift({
                op: 'insert',
                line2: j,
                text: lines2[j - 1],
            });
            j--;
        }
    }

    return ops;
}

/**
 * Check if files are identical
 */
function areIdentical(diff: DiffResult[]): boolean {
    return diff.every(d => d.op === 'equal');
}

/**
 * Format diff in unified format
 */
function formatUnified(
    diff: DiffResult[],
    file1: string,
    file2: string,
    contextLines: number,
    noColor: boolean
): string[] {
    const output: string[] = [];

    // Colors
    const red = noColor ? '' : '\x1b[31m';
    const green = noColor ? '' : '\x1b[32m';
    const cyan = noColor ? '' : '\x1b[36m';
    const reset = noColor ? '' : '\x1b[0m';

    output.push(`${cyan}--- ${file1}${reset}`);
    output.push(`${cyan}+++ ${file2}${reset}`);

    // Group changes into hunks
    let hunkStart = -1;
    let i = 0;

    while (i < diff.length) {
        // Find next change
        while (i < diff.length && diff[i].op === 'equal') i++;
        if (i >= diff.length) break;

        // Start of hunk: include context before
        const contextStart = Math.max(0, i - contextLines);
        let j = i;

        // Find end of changes (including context gaps)
        while (j < diff.length) {
            if (diff[j].op !== 'equal') {
                j++;
            } else {
                // Check if there's another change within context distance
                let nextChange = j;
                while (nextChange < diff.length && diff[nextChange].op === 'equal') {
                    nextChange++;
                }
                if (nextChange < diff.length && nextChange - j <= contextLines * 2) {
                    j = nextChange + 1;
                } else {
                    break;
                }
            }
        }

        // End of hunk: include context after
        const contextEnd = Math.min(diff.length, j + contextLines);

        // Calculate line numbers
        let line1Start = 1, line1Count = 0;
        let line2Start = 1, line2Count = 0;

        for (let k = 0; k < contextStart; k++) {
            if (diff[k].op === 'equal' || diff[k].op === 'delete') line1Start++;
            if (diff[k].op === 'equal' || diff[k].op === 'insert') line2Start++;
        }

        for (let k = contextStart; k < contextEnd; k++) {
            if (diff[k].op === 'equal' || diff[k].op === 'delete') line1Count++;
            if (diff[k].op === 'equal' || diff[k].op === 'insert') line2Count++;
        }

        output.push(`${cyan}@@ -${line1Start},${line1Count} +${line2Start},${line2Count} @@${reset}`);

        // Output hunk lines
        for (let k = contextStart; k < contextEnd; k++) {
            const d = diff[k];
            switch (d.op) {
                case 'equal':
                    output.push(' ' + d.text);
                    break;
                case 'delete':
                    output.push(`${red}-${d.text}${reset}`);
                    break;
                case 'insert':
                    output.push(`${green}+${d.text}${reset}`);
                    break;
            }
        }

        i = contextEnd;
    }

    return output;
}

/**
 * Format diff in side-by-side format
 */
function formatSideBySide(
    diff: DiffResult[],
    noColor: boolean
): string[] {
    const output: string[] = [];
    const width = 38;

    const red = noColor ? '' : '\x1b[31m';
    const green = noColor ? '' : '\x1b[32m';
    const reset = noColor ? '' : '\x1b[0m';

    for (const d of diff) {
        const left = d.op === 'insert' ? '' : d.text.slice(0, width).padEnd(width);
        const right = d.op === 'delete' ? '' : d.text.slice(0, width);

        let sep: string;
        switch (d.op) {
            case 'equal':
                sep = '   ';
                break;
            case 'delete':
                sep = ` ${red}<${reset} `;
                break;
            case 'insert':
                sep = ` ${green}>${reset} `;
                break;
        }

        output.push(left + sep + right);
    }

    return output;
}

export const diff: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`diff: ${err}\n`);
        }
        return 1;
    }

    if (parsed.positional.length < 2) {
        io.stderr.write('diff: missing operand\n');
        io.stderr.write('Usage: diff [options] <file1> <file2>\n');
        return 1;
    }

    const options: DiffOptions = {
        unified: Boolean(parsed.flags.unified),
        context: Boolean(parsed.flags.context),
        sideBySide: Boolean(parsed.flags.sideBySide),
        brief: Boolean(parsed.flags.brief),
        reportSame: Boolean(parsed.flags.reportSame),
        ignoreCase: Boolean(parsed.flags.ignoreCase),
        ignoreAllSpace: Boolean(parsed.flags.ignoreAllSpace),
        ignoreSpaceChange: Boolean(parsed.flags.ignoreSpaceChange),
        ignoreBlankLines: Boolean(parsed.flags.ignoreBlankLines),
        contextLines: typeof parsed.flags.contextLines === 'string'
            ? parseInt(parsed.flags.contextLines, 10)
            : 3,
        noColor: Boolean(parsed.flags.noColor),
    };

    const file1 = parsed.positional[0];
    const file2 = parsed.positional[1];

    // Read files
    let content1: string;
    let content2: string;

    try {
        const resolved1 = resolvePath(session.cwd, file1);
        const data1 = await fs!.read(resolved1);
        content1 = data1.toString();
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`diff: ${file1}: ${err.message}\n`);
            return 2;
        }
        throw err;
    }

    try {
        const resolved2 = resolvePath(session.cwd, file2);
        const data2 = await fs!.read(resolved2);
        content2 = data2.toString();
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`diff: ${file2}: ${err.message}\n`);
            return 2;
        }
        throw err;
    }

    // Split into lines
    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');

    // Remove trailing empty line if file ends with newline
    if (lines1[lines1.length - 1] === '') lines1.pop();
    if (lines2[lines2.length - 1] === '') lines2.pop();

    // Compute diff
    const diffResult = computeDiff(lines1, lines2, options);

    // Check if identical
    if (areIdentical(diffResult)) {
        if (options.reportSame) {
            io.stdout.write(`Files ${file1} and ${file2} are identical\n`);
        }
        return 0;
    }

    // Brief mode
    if (options.brief) {
        io.stdout.write(`Files ${file1} and ${file2} differ\n`);
        return 1;
    }

    // Format output
    let output: string[];

    if (options.sideBySide) {
        output = formatSideBySide(diffResult, options.noColor);
    } else {
        // Default to unified format
        output = formatUnified(diffResult, file1, file2, options.contextLines, options.noColor);
    }

    for (const line of output) {
        io.stdout.write(line + '\n');
    }

    return 1; // diff returns 1 when files differ
};
