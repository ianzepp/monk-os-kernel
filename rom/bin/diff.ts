/**
 * diff - Compare files line by line
 *
 * SYNOPSIS
 * ========
 * diff [OPTIONS] FILE1 FILE2
 *
 * DESCRIPTION
 * ===========
 * Compare two files line by line and output the differences. By default,
 * produces unified diff format showing added, removed, and context lines.
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: POSIX.1-2017 + GNU extensions
 * Supported flags:
 *   -u, --unified[=NUM]  Unified diff format with NUM lines context (default 3)
 *   -U NUM               Same as --unified=NUM
 *   -q, --brief          Report only whether files differ
 *   -s, --report-identical-files  Report when files are identical
 *   --help               Display help
 * Unsupported:
 *   --color              Colorize output (future)
 *   -c                   Context diff format
 *   -e                   Ed script format
 *
 * EXIT CODES
 * ==========
 * 0 - Files are identical
 * 1 - Files differ
 * 2 - Trouble (file not found, cannot read, etc.)
 *
 * OUTPUT FORMAT
 * =============
 * Unified diff format:
 *   --- file1
 *   +++ file2
 *   @@ -start,count +start,count @@
 *    context line
 *   -removed line
 *   +added line
 *    context line
 *
 * @module rom/bin/diff
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { getargs, getcwd, readText, println, eprintln, exit, send, respond } from '@rom/lib/process/index.js';
import { parseArgs, formatError } from '@rom/lib/args';
import { resolvePath } from '@rom/lib/shell';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SAME = 0;
const EXIT_DIFFERENT = 1;
const EXIT_TROUBLE = 2;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: diff [OPTIONS] FILE1 FILE2

Compare files line by line.

Options:
  -u, --unified[=NUM]  Output NUM (default 3) lines of unified context
  -U NUM               Same as --unified=NUM
  -q, --brief          Report only whether files differ
  -s, --report-identical-files  Report when files are identical
  --help               Display this help and exit

Exit status:
  0  Files are identical
  1  Files differ
  2  Trouble (file not found, cannot read, etc.)

Examples:
  diff file1.txt file2.txt       Unified diff with 3 lines context
  diff -u5 file1.txt file2.txt   Unified diff with 5 lines context
  diff -q file1.txt file2.txt    Brief output
`.trim();

// =============================================================================
// TYPES
// =============================================================================

interface DiffOptions {
    unified: boolean;
    context: number;
    brief: boolean;
    reportIdentical: boolean;
}

interface DiffEdit {
    type: 'keep' | 'delete' | 'insert';
    oldLine?: number;
    newLine?: number;
    text: string;
}

interface Hunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffEdit[];
}

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    unified: { short: 'u', long: 'unified', value: true },
    U: { value: true },
    brief: { short: 'q', long: 'brief' },
    reportIdentical: { short: 's', long: 'report-identical-files' },
    help: { long: 'help' },
};

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    if (parsed.flags.help) {
        await println(HELP_TEXT);
        await send(1, respond.done());
        return exit(EXIT_SAME);
    }

    // Parse options
    const options: DiffOptions = {
        unified: parsed.flags.unified !== undefined || parsed.flags.U !== undefined,
        context: 3,
        brief: parsed.flags.brief === true,
        reportIdentical: parsed.flags.reportIdentical === true,
    };

    // Parse context count
    if (parsed.flags.unified !== undefined && parsed.flags.unified !== true) {
        const ctx = parseInt(parsed.flags.unified as string, 10);
        if (!isNaN(ctx) && ctx >= 0) {
            options.context = ctx;
        }
    }
    if (parsed.flags.U !== undefined) {
        const ctx = parseInt(parsed.flags.U as string, 10);
        if (!isNaN(ctx) && ctx >= 0) {
            options.context = ctx;
        }
    }

    // Default to unified format if not brief
    if (!options.brief) {
        options.unified = true;
    }

    // Check for exactly 2 files
    if (parsed.positional.length !== 2) {
        await eprintln('diff: missing operand');
        await eprintln('Try \'diff --help\' for more information.');
        return exit(EXIT_TROUBLE);
    }

    const [file1, file2] = parsed.positional;
    const cwd = await getcwd();

    try {
        const path1 = resolvePath(cwd, file1!);
        const path2 = resolvePath(cwd, file2!);

        const content1 = await readText(path1);
        const content2 = await readText(path2);

        const lines1 = content1.split('\n');
        const lines2 = content2.split('\n');

        // Remove trailing empty line if present (common for text files)
        if (lines1.length > 0 && lines1[lines1.length - 1] === '') {
            lines1.pop();
        }
        if (lines2.length > 0 && lines2[lines2.length - 1] === '') {
            lines2.pop();
        }

        // Check if files are identical
        if (content1 === content2) {
            if (options.reportIdentical) {
                await println(`Files ${file1} and ${file2} are identical`);
            }
            await send(1, respond.done());
            return exit(EXIT_SAME);
        }

        // Files differ
        if (options.brief) {
            await println(`Files ${file1} and ${file2} differ`);
            await send(1, respond.done());
            return exit(EXIT_DIFFERENT);
        }

        // Compute diff
        const edits = computeDiff(lines1, lines2);
        const hunks = buildHunks(edits, lines1, lines2, options.context);

        // Output unified format
        await println(`--- ${file1}`);
        await println(`+++ ${file2}`);

        for (const hunk of hunks) {
            await println(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
            for (const edit of hunk.lines) {
                if (edit.type === 'keep') {
                    await println(` ${edit.text}`);
                }
                else if (edit.type === 'delete') {
                    await println(`-${edit.text}`);
                }
                else if (edit.type === 'insert') {
                    await println(`+${edit.text}`);
                }
            }
        }

        await send(1, respond.done());
        return exit(EXIT_DIFFERENT);
    }
    catch (err) {
        await eprintln(`diff: ${formatError(err)}`);
        return exit(EXIT_TROUBLE);
    }
}

// =============================================================================
// DIFF ALGORITHM
// =============================================================================

/**
 * Compute diff between two arrays of lines using LCS algorithm.
 * Returns a sequence of edit operations.
 */
function computeDiff(oldLines: string[], newLines: string[]): DiffEdit[] {
    const m = oldLines.length;
    const n = newLines.length;

    // Compute LCS length table using dynamic programming
    const lcs: number[][] = Array(m + 1);
    for (let i = 0; i <= m; i++) {
        lcs[i] = Array(n + 1).fill(0);
    }

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                lcs[i]![j] = lcs[i - 1]![j - 1]! + 1;
            }
            else {
                lcs[i]![j] = Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
            }
        }
    }

    // Backtrack to find the edit sequence
    const edits: DiffEdit[] = [];
    let i = m;
    let j = n;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            // Lines match - keep
            edits.unshift({
                type: 'keep',
                oldLine: i - 1,
                newLine: j - 1,
                text: oldLines[i - 1]!,
            });
            i--;
            j--;
        }
        else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
            // Line added in new file
            edits.unshift({
                type: 'insert',
                newLine: j - 1,
                text: newLines[j - 1]!,
            });
            j--;
        }
        else if (i > 0) {
            // Line deleted from old file
            edits.unshift({
                type: 'delete',
                oldLine: i - 1,
                text: oldLines[i - 1]!,
            });
            i--;
        }
    }

    return edits;
}

/**
 * Build hunks from edit sequence with context lines.
 */
function buildHunks(edits: DiffEdit[], oldLines: string[], newLines: string[], contextLines: number): Hunk[] {
    if (edits.length === 0) {
        return [];
    }

    const hunks: Hunk[] = [];
    let currentHunk: Hunk | null = null;

    let oldIdx = 0;
    let newIdx = 0;

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]!;

        if (edit.type === 'keep') {
            // Check if we should start a new hunk or expand current one
            if (currentHunk === null) {
                // Look ahead to see if there are changes coming within context range
                let hasChangesAhead = false;
                for (let j = i + 1; j < Math.min(i + 1 + contextLines, edits.length); j++) {
                    if (edits[j]!.type !== 'keep') {
                        hasChangesAhead = true;
                        break;
                    }
                }

                if (hasChangesAhead) {
                    // Start new hunk with context
                    currentHunk = {
                        oldStart: oldIdx + 1,
                        oldCount: 0,
                        newStart: newIdx + 1,
                        newCount: 0,
                        lines: [],
                    };
                    currentHunk.lines.push(edit);
                    currentHunk.oldCount++;
                    currentHunk.newCount++;
                }
            }
            else {
                // Add to current hunk
                currentHunk.lines.push(edit);
                currentHunk.oldCount++;
                currentHunk.newCount++;

                // Check if we should close the hunk (no more changes within context)
                let hasChangesAhead = false;
                for (let j = i + 1; j < Math.min(i + 1 + contextLines + 1, edits.length); j++) {
                    if (edits[j]!.type !== 'keep') {
                        hasChangesAhead = true;
                        break;
                    }
                }

                if (!hasChangesAhead && i < edits.length - 1) {
                    // Close current hunk
                    hunks.push(currentHunk);
                    currentHunk = null;
                }
            }

            oldIdx++;
            newIdx++;
        }
        else if (edit.type === 'delete') {
            if (currentHunk === null) {
                // Start new hunk with preceding context
                const contextStart = Math.max(0, oldIdx - contextLines);
                currentHunk = {
                    oldStart: contextStart + 1,
                    oldCount: 0,
                    newStart: newIdx + 1,
                    newCount: 0,
                    lines: [],
                };

                // Add preceding context
                for (let k = contextStart; k < oldIdx; k++) {
                    currentHunk.lines.push({
                        type: 'keep',
                        oldLine: k,
                        newLine: newIdx - (oldIdx - k),
                        text: oldLines[k]!,
                    });
                    currentHunk.oldCount++;
                    currentHunk.newCount++;
                }
            }

            currentHunk.lines.push(edit);
            currentHunk.oldCount++;
            oldIdx++;
        }
        else if (edit.type === 'insert') {
            if (currentHunk === null) {
                // Start new hunk with preceding context
                const contextStart = Math.max(0, newIdx - contextLines);
                currentHunk = {
                    oldStart: oldIdx + 1,
                    oldCount: 0,
                    newStart: contextStart + 1,
                    newCount: 0,
                    lines: [],
                };

                // Add preceding context
                for (let k = contextStart; k < newIdx; k++) {
                    currentHunk.lines.push({
                        type: 'keep',
                        oldLine: oldIdx - (newIdx - k),
                        newLine: k,
                        text: newLines[k]!,
                    });
                    currentHunk.oldCount++;
                    currentHunk.newCount++;
                }
            }

            currentHunk.lines.push(edit);
            currentHunk.newCount++;
            newIdx++;
        }
    }

    // Close final hunk if open
    if (currentHunk !== null) {
        hunks.push(currentHunk);
    }

    return hunks;
}
