/**
 * sed - stream editor for filtering and transforming text
 *
 * Usage:
 *   sed [options] <script> [file...]
 *   <input> | sed [options] <script>
 *
 * Options:
 *   -n              Suppress automatic printing
 *   -e <script>     Add script to commands
 *   -i              Edit files in place
 *   -E, -r          Use extended regex
 *
 * Commands:
 *   s/pat/repl/[flags]    Substitute pattern with replacement
 *   d                      Delete line
 *   p                      Print line
 *   q                      Quit
 *   a\text                 Append text after line
 *   i\text                 Insert text before line
 *   c\text                 Replace line with text
 *   y/src/dst/             Transliterate characters
 *   =                      Print line number
 *
 * Addresses:
 *   n                      Line number
 *   $                      Last line
 *   /regex/                Lines matching pattern
 *   n,m                    Range from line n to m
 *   n~step                 Every step-th line starting at n
 *
 * Substitute flags:
 *   g                      Global (all occurrences)
 *   p                      Print if substitution made
 *   i, I                   Case-insensitive
 *   n                      Replace nth occurrence only
 *
 * Examples:
 *   sed 's/foo/bar/' file           Replace first foo with bar
 *   sed 's/foo/bar/g' file          Replace all foo with bar
 *   sed -n '/error/p' log           Print lines containing error
 *   sed '1,10d' file                Delete first 10 lines
 *   sed -i 's/old/new/g' file       In-place replacement
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    quiet: { short: 'n', desc: 'Suppress automatic printing' },
    expression: { short: 'e', value: true, desc: 'Add script command' },
    inPlace: { short: 'i', desc: 'Edit files in place' },
    extended: { short: 'E', desc: 'Extended regex' },
    extendedAlt: { short: 'r', desc: 'Extended regex (alias)' },
};

type SedOptions = {
    quiet: boolean;
    inPlace: boolean;
    extended: boolean;
};

type Address = {
    type: 'line' | 'last' | 'regex' | 'range' | 'step';
    line?: number;
    endLine?: number;
    step?: number;
    regex?: RegExp;
};

type Command = {
    address?: Address;
    address2?: Address;
    cmd: string;
    arg?: string;
    flags?: string;
};

/**
 * Parse an address from script
 */
function parseAddress(str: string, extended: boolean): { addr: Address | null; rest: string } {
    if (!str) return { addr: null, rest: str };

    // Line number
    const lineMatch = str.match(/^(\d+)/);
    if (lineMatch) {
        const line = parseInt(lineMatch[1], 10);
        const rest = str.slice(lineMatch[0].length);

        // Check for step (n~step)
        if (rest.startsWith('~')) {
            const stepMatch = rest.match(/^~(\d+)/);
            if (stepMatch) {
                return {
                    addr: { type: 'step', line, step: parseInt(stepMatch[1], 10) },
                    rest: rest.slice(stepMatch[0].length),
                };
            }
        }

        return { addr: { type: 'line', line }, rest };
    }

    // Last line
    if (str.startsWith('$')) {
        return { addr: { type: 'last' }, rest: str.slice(1) };
    }

    // Regex
    if (str.startsWith('/')) {
        const endIdx = findClosingDelimiter(str, '/', 0);
        if (endIdx === -1) return { addr: null, rest: str };

        const pattern = str.slice(1, endIdx);
        try {
            const flags = extended ? '' : '';
            return {
                addr: { type: 'regex', regex: new RegExp(pattern, flags) },
                rest: str.slice(endIdx + 1),
            };
        } catch {
            return { addr: null, rest: str };
        }
    }

    return { addr: null, rest: str };
}

/**
 * Find closing delimiter, handling escapes
 */
function findClosingDelimiter(str: string, delim: string, start: number): number {
    let escape = false;
    for (let i = start + 1; i < str.length; i++) {
        if (escape) {
            escape = false;
            continue;
        }
        if (str[i] === '\\') {
            escape = true;
            continue;
        }
        if (str[i] === delim) {
            return i;
        }
    }
    return -1;
}

/**
 * Parse a sed command
 */
function parseCommand(script: string, extended: boolean): Command | null {
    let str = script.trim();
    if (!str) return null;

    // Parse first address
    const { addr: addr1, rest: rest1 } = parseAddress(str, extended);
    str = rest1;

    // Check for range (comma)
    let addr2: Address | undefined;
    if (str.startsWith(',')) {
        const { addr, rest } = parseAddress(str.slice(1), extended);
        addr2 = addr || undefined;
        str = rest;
    }

    // Get command character
    const cmdChar = str[0];
    if (!cmdChar) return null;

    str = str.slice(1);

    // Handle different commands
    switch (cmdChar) {
        case 's': {
            // s/pattern/replacement/flags
            const delim = str[0];
            if (!delim) return null;

            const patEnd = findClosingDelimiter(str, delim, 0);
            if (patEnd === -1) return null;

            const replEnd = findClosingDelimiter(str, delim, patEnd);
            const pattern = str.slice(1, patEnd);
            const replacement = replEnd === -1
                ? str.slice(patEnd + 1)
                : str.slice(patEnd + 1, replEnd);
            const flags = replEnd === -1 ? '' : str.slice(replEnd + 1);

            return {
                address: addr1 || undefined,
                address2: addr2,
                cmd: 's',
                arg: `${pattern}\x00${replacement}`,
                flags,
            };
        }

        case 'y': {
            // y/source/dest/
            const delim = str[0];
            if (!delim) return null;

            const srcEnd = findClosingDelimiter(str, delim, 0);
            if (srcEnd === -1) return null;

            const dstEnd = findClosingDelimiter(str, delim, srcEnd);
            const source = str.slice(1, srcEnd);
            const dest = dstEnd === -1
                ? str.slice(srcEnd + 1)
                : str.slice(srcEnd + 1, dstEnd);

            return {
                address: addr1 || undefined,
                address2: addr2,
                cmd: 'y',
                arg: `${source}\x00${dest}`,
            };
        }

        case 'd':
        case 'p':
        case 'q':
        case '=':
            return {
                address: addr1 || undefined,
                address2: addr2,
                cmd: cmdChar,
            };

        case 'a':
        case 'i':
        case 'c': {
            // a\text, i\text, c\text
            let text = str;
            if (text.startsWith('\\')) {
                text = text.slice(1);
            }
            return {
                address: addr1 || undefined,
                address2: addr2,
                cmd: cmdChar,
                arg: text,
            };
        }

        default:
            return null;
    }
}

/**
 * Check if line number matches address
 */
function matchesAddress(
    addr: Address,
    lineNum: number,
    line: string,
    lastLine: number
): boolean {
    switch (addr.type) {
        case 'line':
            return lineNum === addr.line;
        case 'last':
            return lineNum === lastLine;
        case 'regex':
            return addr.regex!.test(line);
        case 'step':
            return lineNum >= addr.line! && (lineNum - addr.line!) % addr.step! === 0;
        default:
            return false;
    }
}

/**
 * Check if line is in range
 */
function inRange(
    cmd: Command,
    lineNum: number,
    line: string,
    lastLine: number,
    rangeState: Map<Command, boolean>
): boolean {
    if (!cmd.address) return true;

    if (!cmd.address2) {
        return matchesAddress(cmd.address, lineNum, line, lastLine);
    }

    // Range address
    const inRangeNow = rangeState.get(cmd) || false;

    if (!inRangeNow) {
        if (matchesAddress(cmd.address, lineNum, line, lastLine)) {
            rangeState.set(cmd, true);
            return true;
        }
        return false;
    } else {
        if (matchesAddress(cmd.address2, lineNum, line, lastLine)) {
            rangeState.set(cmd, false);
        }
        return true;
    }
}

/**
 * Apply substitute command
 */
function applySubstitute(
    line: string,
    arg: string,
    flags: string,
    extended: boolean
): { result: string; changed: boolean } {
    const [pattern, replacement] = arg.split('\x00');

    const caseInsensitive = /[iI]/.test(flags);
    const global = flags.includes('g');
    const nthMatch = flags.match(/(\d+)/);
    const nth = nthMatch ? parseInt(nthMatch[1], 10) : null;

    let regexFlags = caseInsensitive ? 'i' : '';
    if (global) regexFlags += 'g';

    let regex: RegExp;
    try {
        regex = new RegExp(pattern, regexFlags);
    } catch {
        return { result: line, changed: false };
    }

    // Handle replacement escapes
    const repl = replacement
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');

    if (nth !== null) {
        // Replace nth occurrence only
        let count = 0;
        const result = line.replace(new RegExp(pattern, 'g' + (caseInsensitive ? 'i' : '')), (match) => {
            count++;
            return count === nth ? repl.replace(/&/g, match) : match;
        });
        return { result, changed: result !== line };
    }

    const result = line.replace(regex, (match, ...groups) => {
        let r = repl;
        // Handle & (entire match)
        r = r.replace(/&/g, match);
        // Handle \1, \2, etc. (captured groups)
        r = r.replace(/\\(\d)/g, (_, n) => groups[parseInt(n, 10) - 1] || '');
        return r;
    });

    return { result, changed: result !== line };
}

/**
 * Apply transliterate command
 */
function applyTransliterate(line: string, arg: string): string {
    const [source, dest] = arg.split('\x00');
    if (source.length !== dest.length) return line;

    const map = new Map<string, string>();
    for (let i = 0; i < source.length; i++) {
        map.set(source[i], dest[i]);
    }

    return [...line].map(c => map.get(c) ?? c).join('');
}

/**
 * Process lines with sed commands
 */
function processLines(
    lines: string[],
    commands: Command[],
    options: SedOptions
): string[] {
    const output: string[] = [];
    const rangeState = new Map<Command, boolean>();
    const lastLine = lines.length;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const lineNum = i + 1;
        let print = !options.quiet;
        let deleted = false;
        let quit = false;

        for (const cmd of commands) {
            if (!inRange(cmd, lineNum, line, lastLine, rangeState)) {
                continue;
            }

            switch (cmd.cmd) {
                case 's': {
                    const { result, changed } = applySubstitute(
                        line, cmd.arg!, cmd.flags || '', options.extended
                    );
                    line = result;
                    if (changed && cmd.flags?.includes('p')) {
                        output.push(line);
                    }
                    break;
                }

                case 'y':
                    line = applyTransliterate(line, cmd.arg!);
                    break;

                case 'd':
                    deleted = true;
                    print = false;
                    break;

                case 'p':
                    output.push(line);
                    break;

                case 'q':
                    if (print && !deleted) output.push(line);
                    print = false;  // Prevent duplicate output after loop
                    quit = true;
                    break;

                case '=':
                    output.push(String(lineNum));
                    break;

                case 'a':
                    // Append after current line - handled after print
                    break;

                case 'i':
                    output.push(cmd.arg!);
                    break;

                case 'c':
                    output.push(cmd.arg!);
                    deleted = true;
                    print = false;
                    break;
            }

            if (deleted || quit) break;
        }

        if (print && !deleted) {
            output.push(line);
        }

        // Handle append commands
        for (const cmd of commands) {
            if (cmd.cmd === 'a' && inRange(cmd, lineNum, lines[i], lastLine, rangeState)) {
                output.push(cmd.arg!);
            }
        }

        if (quit) break;
    }

    return output;
}

export const sed: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`sed: ${err}\n`);
        }
        return 1;
    }

    const options: SedOptions = {
        quiet: Boolean(parsed.flags.quiet),
        inPlace: Boolean(parsed.flags.inPlace),
        extended: Boolean(parsed.flags.extended || parsed.flags.extendedAlt),
    };

    // Collect scripts (-e expressions or first positional)
    const scripts: string[] = [];
    if (typeof parsed.flags.expression === 'string') {
        scripts.push(parsed.flags.expression);
    }

    let files = parsed.positional;
    if (scripts.length === 0 && files.length > 0) {
        scripts.push(files[0]);
        files = files.slice(1);
    }

    if (scripts.length === 0) {
        io.stderr.write('sed: missing script\n');
        io.stderr.write('Usage: sed [options] <script> [file...]\n');
        return 1;
    }

    // Parse commands
    const commands: Command[] = [];
    for (const script of scripts) {
        // Split on semicolons or newlines (basic multi-command support)
        const parts = script.split(/[;\n]/).filter(s => s.trim());
        for (const part of parts) {
            const cmd = parseCommand(part, options.extended);
            if (cmd) {
                commands.push(cmd);
            }
        }
    }

    if (commands.length === 0) {
        io.stderr.write('sed: invalid script\n');
        return 1;
    }

    // Read content
    if (files.length === 0) {
        // Read from stdin
        let buffer = '';
        for await (const chunk of io.stdin) {
            buffer += chunk.toString();
        }

        const lines = buffer.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();

        const output = processLines(lines, commands, options);
        for (const line of output) {
            io.stdout.write(line + '\n');
        }

        return 0;
    }

    // Process files
    for (const file of files) {
        const resolved = resolvePath(session.cwd, file);

        try {
            const data = await fs!.read(resolved);
            const content = data.toString();
            const lines = content.split('\n');
            if (lines[lines.length - 1] === '') lines.pop();

            const output = processLines(lines, commands, options);
            const result = output.join('\n') + (output.length > 0 ? '\n' : '');

            if (options.inPlace) {
                await fs!.write(resolved, Buffer.from(result));
            } else {
                io.stdout.write(result);
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`sed: ${file}: ${err.message}\n`);
                return 1;
            }
            throw err;
        }
    }

    return 0;
};
