/**
 * awk - pattern scanning and text processing language
 *
 * Usage:
 *   awk [options] 'program' [file...]
 *   awk [options] -f progfile [file...]
 *   <input> | awk [options] 'program'
 *
 * Options:
 *   -F fs           Field separator (default: whitespace)
 *   -v var=value    Set variable before execution
 *   -f progfile     Read program from file
 *
 * Program Structure:
 *   BEGIN { actions }           Execute before input
 *   pattern { actions }         Execute for matching lines
 *   END { actions }             Execute after input
 *
 * Patterns:
 *   /regex/                     Match regex against $0
 *   expression                  True if non-zero/non-empty
 *   /start/,/end/              Range pattern
 *
 * Fields:
 *   $0                          Entire record
 *   $1, $2, ...                 Individual fields
 *   $NF                         Last field
 *
 * Built-in Variables:
 *   FS, RS                      Input field/record separator
 *   OFS, ORS                    Output field/record separator
 *   NR                          Total record number
 *   NF                          Number of fields
 *   FNR                         Record number in file
 *   FILENAME                    Current filename
 *
 * Built-in Functions:
 *   length(s)                   String length
 *   substr(s, start, len)       Substring
 *   index(s, t)                 Position of t in s
 *   split(s, a, fs)             Split string into array
 *   sub(r, s, t)                Substitute first match
 *   gsub(r, s, t)               Substitute all matches
 *   match(s, r)                 Match regex, set RSTART/RLENGTH
 *   tolower(s), toupper(s)      Case conversion
 *   sprintf(fmt, ...)           Format string
 *   sin, cos, atan2, exp, log   Math functions
 *   sqrt, int, rand, srand      Math functions
 *
 * Examples:
 *   awk '{print $1}'                         Print first field
 *   awk -F: '{print $1}' /etc/passwd         Print usernames
 *   awk '/error/{print}' log                 Print lines with error
 *   awk '{sum+=$1} END{print sum}'           Sum first column
 *   awk 'NR>1{print $2}' data                Skip header, print col 2
 */

import {
    getargs,
    getcwd,
    readText,
    readFile,
    print,
    println,
    eprintln,
    exit,
    onSignal,
    SIGTERM,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';
import { Lexer, Parser, Interpreter } from '@rom/lib/awk';

const abortController = new AbortController();

onSignal((signal) => {
    if (signal === SIGTERM) {
        abortController.abort();
    }
});

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0) {
        await eprintln('awk: no program given');
        await eprintln('Usage: awk [options] \'program\' [file...]');
        await exit(1);
    }

    if (argv[0] === '-h' || argv[0] === '--help') {
        await showHelp();
        await exit(0);
    }

    // Parse options
    let fieldSep: string | null = null;
    let progFile: string | null = null;
    const variables: Array<{ name: string; value: string }> = [];
    const positional: string[] = [];

    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        if (!arg) {
            i++;
            continue;
        }

        if (arg === '-F' && i + 1 < argv.length) {
            const nextArg = argv[i + 1];
            if (nextArg) {
                fieldSep = nextArg;
            }
            i += 2;
        } else if (arg.startsWith('-F')) {
            fieldSep = arg.slice(2);
            i++;
        } else if (arg === '-v' && i + 1 < argv.length) {
            const assignment = argv[i + 1];
            if (assignment) {
                const eqIdx = assignment.indexOf('=');
                if (eqIdx > 0) {
                    variables.push({
                        name: assignment.slice(0, eqIdx),
                        value: assignment.slice(eqIdx + 1),
                    });
                }
            }
            i += 2;
        } else if (arg === '-f' && i + 1 < argv.length) {
            const nextArg = argv[i + 1];
            if (nextArg) {
                progFile = nextArg;
            }
            i += 2;
        } else if (arg.startsWith('-') && arg !== '-') {
            await eprintln(`awk: unknown option: ${arg}`);
            return exit(1);
        } else {
            positional.push(arg);
            i++;
        }
    }

    // Get program source
    const cwd = await getcwd();
    let programSource: string;

    if (progFile) {
        const resolved = resolvePath(cwd, progFile);
        try {
            programSource = await readFileContent(resolved);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`awk: ${progFile}: ${msg}`);
            return exit(1);
        }
    } else if (positional.length > 0) {
        const prog = positional.shift();
        if (!prog) {
            await eprintln('awk: no program given');
            return exit(1);
        }
        programSource = prog;
    } else {
        await eprintln('awk: no program given');
        return exit(1);
    }

    // Parse program
    let program;
    try {
        const lexer = new Lexer(programSource);
        const tokens = lexer.tokenize();
        const parser = new Parser(tokens);
        program = parser.parse();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`awk: ${msg}`);
        return exit(1);
    }

    // Create interpreter
    if (!program) {
        await eprintln('awk: failed to parse program');
        return exit(1);
    }
    const interpreter = new Interpreter(
        program,
        (text: string) => { print(text); },
        (text: string) => { eprintln(text); },
        abortController.signal
    );

    // Set field separator
    if (fieldSep) {
        interpreter.setFieldSeparator(fieldSep);
    }

    // Set variables
    for (const { name, value } of variables) {
        const num = parseFloat(value);
        interpreter.setVariable(name, isNaN(num) ? value : num);
    }

    // Get input
    let input = '';

    if (positional.length > 0) {
        // Read from files
        for (const file of positional) {
            if (abortController.signal.aborted) {
                await exit(130);
            }

            const resolved = resolvePath(cwd, file);
            try {
                const content = await readFileContent(resolved);
                input += content;
                if (!input.endsWith('\n')) {
                    input += '\n';
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await eprintln(`awk: ${file}: ${msg}`);
                await exit(1);
            }
        }
    } else {
        // Read from stdin
        input = await readStdin();
    }

    // Run program
    try {
        const exitCode = await interpreter.run(input);
        await exit(exitCode);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`awk: ${msg}`);
        await exit(1);
    }
}

async function readFileContent(path: string): Promise<string> {
    return readFile(path);
}

async function readStdin(): Promise<string> {
    return readText(0);
}

async function showHelp(): Promise<void> {
    await println('Usage: awk [options] \'program\' [file...]');
    await println('');
    await println('Options:');
    await println('  -F fs           Field separator');
    await println('  -v var=value    Set variable');
    await println('  -f progfile     Read program from file');
    await println('');
    await println('Examples:');
    await println('  awk \'{print $1}\'                    Print first field');
    await println('  awk -F: \'{print $1}\' /etc/passwd    Print usernames');
    await println('  awk \'/error/{print}\' log            Print lines with error');
    await println('  awk \'{sum+=$1} END{print sum}\'      Sum first column');
}

main().catch(async (err) => {
    await eprintln(`awk: ${err.message}`);
    await exit(1);
});
