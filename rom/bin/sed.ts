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

import {
    getargs,
    getcwd,
    open,
    readText,
    readFile,
    write,
    close,
    println,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';

// ============================================================================
// Types
// ============================================================================

interface SedOptions {
    quiet: boolean;
    inPlace: boolean;
    extended: boolean;
}

interface Address {
    type: 'line' | 'last' | 'regex' | 'range' | 'step';
    line?: number;
    endLine?: number;
    step?: number;
    regex?: RegExp;
}

interface Command {
    address?: Address;
    address2?: Address;
    cmd: string;
    arg?: string;
    flags?: string;
}

// ============================================================================
// Parsing
// ============================================================================

function parseAddress(str: string, _extended: boolean): { addr: Address | null; rest: string } {
    if (!str) {
        return { addr: null, rest: str };
    }

    // Line number
    const lineMatch = str.match(/^(\d+)/);

    if (lineMatch && lineMatch[1]) {
        const line = parseInt(lineMatch[1], 10);
        const rest = str.slice(lineMatch[0].length);

        // Check for step (n~step)
        if (rest.startsWith('~')) {
            const stepMatch = rest.match(/^~(\d+)/);

            if (stepMatch && stepMatch[1]) {
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

        if (endIdx === -1) {
            return { addr: null, rest: str };
        }

        const pattern = str.slice(1, endIdx);

        try {
            return {
                addr: { type: 'regex', regex: new RegExp(pattern) },
                rest: str.slice(endIdx + 1),
            };
        }
        catch {
            return { addr: null, rest: str };
        }
    }

    return { addr: null, rest: str };
}

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

function parseCommand(script: string, extended: boolean): Command | null {
    let str = script.trim();

    if (!str) {
        return null;
    }

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

    if (!cmdChar) {
        return null;
    }

    str = str.slice(1);

    // Handle different commands
    switch (cmdChar) {
        case 's': {
            const delim = str[0];

            if (!delim) {
                return null;
            }

            const patEnd = findClosingDelimiter(str, delim, 0);

            if (patEnd === -1) {
                return null;
            }

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
            const delim = str[0];

            if (!delim) {
                return null;
            }

            const srcEnd = findClosingDelimiter(str, delim, 0);

            if (srcEnd === -1) {
                return null;
            }

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

// ============================================================================
// Execution
// ============================================================================

function matchesAddress(
    addr: Address,
    lineNum: number,
    line: string,
    lastLine: number,
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

function inRange(
    cmd: Command,
    lineNum: number,
    line: string,
    lastLine: number,
    rangeState: Map<Command, boolean>,
): boolean {
    if (!cmd.address) {
        return true;
    }

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
    }
    else {
        if (matchesAddress(cmd.address2, lineNum, line, lastLine)) {
            rangeState.set(cmd, false);
        }

        return true;
    }
}

function applySubstitute(
    line: string,
    arg: string,
    flags: string,
    _extended: boolean,
): { result: string; changed: boolean } {
    const parts = arg.split('\x00');
    const pattern = parts[0];
    const replacement = parts[1];

    if (!pattern || replacement === undefined) {
        return { result: line, changed: false };
    }

    const caseInsensitive = /[iI]/.test(flags);
    const global = flags.includes('g');
    const nthMatch = flags.match(/(\d+)/);
    const nth = nthMatch && nthMatch[1] ? parseInt(nthMatch[1], 10) : null;

    let regexFlags = caseInsensitive ? 'i' : '';

    if (global) {
        regexFlags += 'g';
    }

    let regex: RegExp;

    try {
        regex = new RegExp(pattern, regexFlags);
    }
    catch {
        return { result: line, changed: false };
    }

    // Handle replacement escapes
    const repl = (replacement || '')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');

    if (nth !== null) {
        // Replace nth occurrence only
        let count = 0;
        const result = line.replace(new RegExp(pattern, 'g' + (caseInsensitive ? 'i' : '')), match => {
            count++;

            return count === nth ? repl.replace(/&/g, match) : match;
        });

        return { result, changed: result !== line };
    }

    const result = line.replace(regex, (match, ...groups) => {
        let r = repl;

        r = r.replace(/&/g, match);
        r = r.replace(/\\(\d)/g, (_, n) => groups[parseInt(n, 10) - 1] || '');

        return r;
    });

    return { result, changed: result !== line };
}

function applyTransliterate(line: string, arg: string): string {
    const parts = arg.split('\x00');
    const source = parts[0];
    const dest = parts[1];

    if (!source || !dest || source.length !== dest.length) {
        return line;
    }

    const map = new Map<string, string>();

    for (let i = 0; i < source.length; i++) {
        const srcChar = source[i];
        const dstChar = dest[i];

        if (srcChar && dstChar) {
            map.set(srcChar, dstChar);
        }
    }

    return [...line].map(c => map.get(c) ?? c).join('');
}

function processLines(
    lines: string[],
    commands: Command[],
    options: SedOptions,
): string[] {
    const output: string[] = [];
    const rangeState = new Map<Command, boolean>();
    const lastLine = lines.length;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        if (line === undefined) {
            continue;
        }

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
                    if (cmd.arg) {
                        const { result, changed } = applySubstitute(
                            line, cmd.arg, cmd.flags || '', options.extended,
                        );

                        line = result;
                        if (changed && cmd.flags?.includes('p')) {
                            output.push(line);
                        }
                    }

                    break;
                }

                case 'y':
                    if (cmd.arg) {
                        line = applyTransliterate(line, cmd.arg);
                    }

                    break;

                case 'd':
                    deleted = true;
                    print = false;
                    break;

                case 'p':
                    output.push(line);
                    break;

                case 'q':
                    if (print && !deleted) {
                        output.push(line);
                    }

                    print = false;
                    quit = true;
                    break;

                case '=':
                    output.push(String(lineNum));
                    break;

                case 'a':
                    break;

                case 'i':
                    if (cmd.arg) {
                        output.push(cmd.arg);
                    }

                    break;

                case 'c':
                    if (cmd.arg) {
                        output.push(cmd.arg);
                    }

                    deleted = true;
                    print = false;
                    break;
            }

            if (deleted || quit) {
                break;
            }
        }

        if (print && !deleted) {
            output.push(line);
        }

        // Handle append commands
        for (const cmd of commands) {
            const currentLine = lines[i];

            if (cmd.cmd === 'a' && currentLine && inRange(cmd, lineNum, currentLine, lastLine, rangeState)) {
                if (cmd.arg) {
                    output.push(cmd.arg);
                }
            }
        }

        if (quit) {
            break;
        }
    }

    return output;
}

// ============================================================================
// Command
// ============================================================================

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0) {
        await eprintln('sed: missing script');
        await eprintln('Usage: sed [options] <script> [file...]');
        await exit(1);
    }

    if (argv[0] === '-h' || argv[0] === '--help') {
        await showHelp();
        await exit(0);
    }

    // Parse options
    const options: SedOptions = {
        quiet: false,
        inPlace: false,
        extended: false,
    };

    const scripts: string[] = [];
    const files: string[] = [];

    let i = 0;

    while (i < argv.length) {
        const arg = argv[i];

        if (!arg) {
            i++;
            continue;
        }

        if (arg === '-n') {
            options.quiet = true;
            i++;
        }
        else if (arg === '-i') {
            options.inPlace = true;
            i++;
        }
        else if (arg === '-E' || arg === '-r') {
            options.extended = true;
            i++;
        }
        else if (arg === '-e' && i + 1 < argv.length) {
            const scriptArg = argv[i + 1];

            if (scriptArg) {
                scripts.push(scriptArg);
            }

            i += 2;
        }
        else if (arg.startsWith('-') && arg !== '-') {
            await eprintln(`sed: unknown option: ${arg}`);
            await exit(1);
        }
        else {
            // First non-option is script if no -e given, rest are files
            if (scripts.length === 0) {
                scripts.push(arg);
            }
            else {
                files.push(arg);
            }

            i++;
        }
    }

    if (scripts.length === 0) {
        await eprintln('sed: missing script');
        await exit(1);
    }

    // Parse commands
    const commands: Command[] = [];

    for (const script of scripts) {
        const parts = script.split(/[;\n]/).filter(s => s.trim());

        for (const part of parts) {
            const cmd = parseCommand(part, options.extended);

            if (cmd) {
                commands.push(cmd);
            }
        }
    }

    if (commands.length === 0) {
        await eprintln('sed: invalid script');
        await exit(1);
    }

    const cwd = await getcwd();

    // Process input
    if (files.length === 0) {
        // Read from stdin
        const content = await readStdin();
        const lines = content.split('\n');

        if (lines[lines.length - 1] === '') {
            lines.pop();
        }

        const output = processLines(lines, commands, options);

        for (const line of output) {
            await println(line);
        }
    }
    else {
        // Process files
        for (const file of files) {
            const resolved = resolvePath(cwd, file);

            try {
                const content = await readFileContent(resolved);
                const lines = content.split('\n');

                if (lines[lines.length - 1] === '') {
                    lines.pop();
                }

                const output = processLines(lines, commands, options);
                const result = output.join('\n') + (output.length > 0 ? '\n' : '');

                if (options.inPlace) {
                    await writeFileContent(resolved, result);
                }
                else {
                    for (const line of output) {
                        await println(line);
                    }
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                await eprintln(`sed: ${file}: ${msg}`);
                await exit(1);
            }
        }
    }

    await exit(0);
}

async function readFileContent(path: string): Promise<string> {
    return readFile(path);
}

async function writeFileContent(path: string, content: string): Promise<void> {
    const fd = await open(path, { write: true, create: true, truncate: true });

    try {
        await write(fd, new TextEncoder().encode(content));
    }
    finally {
        await close(fd);
    }
}

async function readStdin(): Promise<string> {
    return readText(0);
}

async function showHelp(): Promise<void> {
    await println('Usage: sed [options] <script> [file...]');
    await println('');
    await println('Options:');
    await println('  -n              Suppress automatic printing');
    await println('  -e <script>     Add script to commands');
    await println('  -i              Edit files in place');
    await println('  -E, -r          Use extended regex');
    await println('');
    await println('Commands:');
    await println('  s/pat/repl/[flags]    Substitute');
    await println('  d                      Delete line');
    await println('  p                      Print line');
    await println('  q                      Quit');
    await println('');
    await println('Examples:');
    await println('  sed \'s/foo/bar/\' file');
    await println('  sed -n \'/error/p\' log');
    await println('  sed \'1,10d\' file');
}

main().catch(async err => {
    await eprintln(`sed: ${err.message}`);
    await exit(1);
});
