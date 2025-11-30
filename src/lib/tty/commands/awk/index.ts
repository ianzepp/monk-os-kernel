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
 *   awk 'BEGIN{FS=","} {print $3}'           CSV third column
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../../parser.js';
import type { CommandHandler } from '../shared.js';
import { parseArgs } from '../shared.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Interpreter } from './interpreter.js';

const argSpecs = {
    fieldSep: { short: 'F', value: true, desc: 'Field separator' },
    variable: { short: 'v', value: true, desc: 'Set variable var=value' },
    file: { short: 'f', value: true, desc: 'Read program from file' },
};

export const awk: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`awk: ${err}\n`);
        }
        return 1;
    }

    // Collect -v variable assignments (may be multiple)
    const variables: Array<{ name: string; value: string }> = [];

    // Re-parse args to handle multiple -v flags
    let i = 0;
    while (i < args.length) {
        if (args[i] === '-v' && i + 1 < args.length) {
            const assignment = args[i + 1];
            const eqIdx = assignment.indexOf('=');
            if (eqIdx > 0) {
                variables.push({
                    name: assignment.slice(0, eqIdx),
                    value: assignment.slice(eqIdx + 1),
                });
            }
            i += 2;
        } else {
            i++;
        }
    }

    // Get program source
    let programSource: string;

    if (parsed.flags.file) {
        // Read program from file
        const progFile = resolvePath(session.cwd, String(parsed.flags.file));
        try {
            const data = await fs!.read(progFile);
            programSource = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`awk: ${parsed.flags.file}: ${err.message}\n`);
                return 1;
            }
            throw err;
        }
    } else if (parsed.positional.length > 0) {
        // Program is first positional argument
        programSource = parsed.positional[0];
        parsed.positional = parsed.positional.slice(1);
    } else {
        io.stderr.write('awk: no program given\n');
        io.stderr.write('Usage: awk [options] \'program\' [file...]\n');
        return 1;
    }

    // Parse program
    let program;
    try {
        const lexer = new Lexer(programSource);
        const tokens = lexer.tokenize();
        const parser = new Parser(tokens);
        program = parser.parse();
    } catch (err) {
        io.stderr.write(`awk: ${(err as Error).message}\n`);
        return 1;
    }

    // Create interpreter
    const interpreter = new Interpreter(
        program,
        (text) => io.stdout.write(text),
        (text) => io.stderr.write(text),
        io.signal
    );

    // Set field separator
    if (parsed.flags.fieldSep) {
        interpreter.setFieldSeparator(String(parsed.flags.fieldSep));
    }

    // Set variables
    for (const { name, value } of variables) {
        // Try to parse as number
        const num = parseFloat(value);
        interpreter.setVariable(name, isNaN(num) ? value : num);
    }

    // Get input
    let input = '';

    if (parsed.positional.length > 0) {
        // Read from files
        for (const file of parsed.positional) {
            if (io.signal?.aborted) return 130;

            const resolved = resolvePath(session.cwd, file);
            try {
                const data = await fs!.read(resolved);
                input += data.toString();
                // Ensure file ends with newline for proper record splitting
                if (!input.endsWith('\n')) {
                    input += '\n';
                }
            } catch (err) {
                if (err instanceof FSError) {
                    io.stderr.write(`awk: ${file}: ${err.message}\n`);
                    return 1;
                }
                throw err;
            }
        }
    } else {
        // Read from stdin
        for await (const chunk of io.stdin) {
            if (io.signal?.aborted) return 130;
            input += chunk.toString();
        }
    }

    // Run program
    try {
        const exitCode = await interpreter.run(input);
        return exitCode;
    } catch (err) {
        io.stderr.write(`awk: ${(err as Error).message}\n`);
        return 1;
    }
};
