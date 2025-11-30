/**
 * jq - JSON query and transform
 *
 * Usage:
 *   <input> | jq [options] <expression>
 *   jq [options] <expression> < file
 *
 * Options:
 *   -r, --raw-output    Output raw strings (no quotes)
 *   -c, --compact       Compact output (no pretty printing)
 *   -s, --slurp         Read all inputs into an array
 *   -n, --null-input    Use null as input (don't read stdin)
 *   -e, --exit-status   Set exit code based on output
 *   -S, --sort-keys     Sort object keys
 *
 * Expression syntax:
 *   .                   Identity (return input)
 *   .foo                Field access
 *   .foo.bar            Nested field access
 *   .foo?               Optional field (no error if missing)
 *   .[0]                Array index
 *   .[-1]               Negative index (from end)
 *   .[2:5]              Array slice
 *   .[]                 Iterate array/object values
 *   |                   Pipe (chain operations)
 *   ,                   Multiple outputs
 *   + - * / %           Arithmetic
 *   == != < <= > >=     Comparison
 *   and or not          Boolean logic
 *   [...]               Array construction
 *   {...}               Object construction
 *   select(cond)        Filter by condition
 *   map(expr)           Transform array elements
 *   keys, values        Object keys/values
 *   length, type        Introspection
 *   sort, reverse       Array operations
 *   first, last         Array access
 *   add, min, max       Aggregation
 *   split, join         String operations
 *   test, match         Regex matching
 *   tostring, tonumber  Type conversion
 *
 * Examples:
 *   cat data.json | jq .name
 *   cat data.json | jq '.users[0].email'
 *   cat data.json | jq '.items | map(.price) | add'
 *   cat data.json | jq 'select(.age > 18)'
 *   cat data.json | jq '{name: .name, count: (.items | length)}'
 */

import type { CommandHandler } from '../shared.js';
import type { JqContext } from './types.js';
import { Parser } from './parser.js';
import { evaluate } from './evaluator.js';

interface JqOptions {
    raw: boolean;
    compact: boolean;
    slurp: boolean;
    nullInput: boolean;
    exitStatus: boolean;
    sortKeys: boolean;
}

export const jq: CommandHandler = async (_session, _fs, args, io) => {
    // Parse options
    const options: JqOptions = {
        raw: false,
        compact: false,
        slurp: false,
        nullInput: false,
        exitStatus: false,
        sortKeys: false,
    };

    let expression: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-r' || arg === '--raw-output') {
            options.raw = true;
        } else if (arg === '-c' || arg === '--compact') {
            options.compact = true;
        } else if (arg === '-s' || arg === '--slurp') {
            options.slurp = true;
        } else if (arg === '-n' || arg === '--null-input') {
            options.nullInput = true;
        } else if (arg === '-e' || arg === '--exit-status') {
            options.exitStatus = true;
        } else if (arg === '-S' || arg === '--sort-keys') {
            options.sortKeys = true;
        } else if (!arg.startsWith('-')) {
            expression = arg;
        }
    }

    if (!expression) {
        io.stderr.write('jq: missing expression\n');
        io.stderr.write('Usage: jq [options] <expression>\n');
        io.stderr.write('Examples: jq .name, jq ".users | map(.email)", jq "select(.active)"\n');
        return 1;
    }

    // Parse expression
    let ast;
    try {
        const parser = new Parser();
        ast = parser.parse(expression);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderr.write(`jq: parse error: ${msg}\n`);
        return 3;
    }

    // Read input
    let inputs: any[] = [];

    if (options.nullInput) {
        inputs = [null];
    } else {
        let buffer = '';
        for await (const chunk of io.stdin) {
            buffer += chunk.toString();
        }
        buffer = buffer.trim();

        if (!buffer) {
            inputs = [null];
        } else if (options.slurp) {
            // Parse all inputs and wrap in array
            const lines = buffer.split('\n').filter(l => l.trim());
            const items: any[] = [];
            for (const line of lines) {
                try {
                    items.push(JSON.parse(line));
                } catch {
                    // Try parsing entire buffer as single JSON
                    try {
                        inputs = [JSON.parse(buffer)];
                        break;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        io.stderr.write(`jq: parse error: ${msg}\n`);
                        return 4;
                    }
                }
            }
            if (inputs.length === 0) {
                inputs = [items];
            }
        } else {
            // Parse each line as separate JSON
            const lines = buffer.split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    inputs.push(JSON.parse(line));
                } catch {
                    // If single line, try the whole buffer
                    if (lines.length === 1) {
                        try {
                            inputs.push(JSON.parse(buffer));
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            io.stderr.write(`jq: parse error: ${msg}\n`);
                            return 4;
                        }
                    } else {
                        io.stderr.write(`jq: skipping invalid JSON line\n`);
                    }
                }
            }
        }
    }

    // Evaluate expression on each input
    let hasOutput = false;
    let lastValue: any = null;

    for (const input of inputs) {
        const ctx: JqContext = {
            input,
            variables: new Map(),
            outputs: [],
        };

        try {
            const results = evaluate(ast, ctx);

            for (const result of results) {
                hasOutput = true;
                lastValue = result;
                outputValue(result, options, io);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            io.stderr.write(`jq: error: ${msg}\n`);
            return 5;
        }
    }

    // Exit status based on output
    if (options.exitStatus) {
        if (!hasOutput) return 1;
        if (lastValue === false || lastValue === null) return 1;
    }

    return 0;
};

/**
 * Output a single value according to options
 */
function outputValue(value: any, options: JqOptions, io: { stdout: { write: (s: string | Buffer) => void } }): void {
    if (value === undefined) {
        io.stdout.write('null\n');
        return;
    }

    // Raw output for strings
    if (options.raw && typeof value === 'string') {
        io.stdout.write(value + '\n');
        return;
    }

    // Sort keys if requested
    if (options.sortKeys && typeof value === 'object' && value !== null) {
        value = sortObjectKeys(value);
    }

    // Format output
    if (options.compact) {
        io.stdout.write(JSON.stringify(value) + '\n');
    } else {
        io.stdout.write(JSON.stringify(value, null, 2) + '\n');
    }
}

/**
 * Recursively sort object keys
 */
function sortObjectKeys(value: any): any {
    if (Array.isArray(value)) {
        return value.map(sortObjectKeys);
    }
    if (typeof value === 'object' && value !== null) {
        const sorted: Record<string, any> = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortObjectKeys(value[key]);
        }
        return sorted;
    }
    return value;
}
