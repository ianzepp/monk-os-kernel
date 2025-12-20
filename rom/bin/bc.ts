/**
 * bc - Arbitrary precision calculator
 *
 * SYNOPSIS
 * ========
 * bc [OPTIONS] [EXPRESSION]
 *
 * DESCRIPTION
 * ===========
 * Evaluate mathematical expressions and print the result.
 *
 * Supported operations:
 *   +, -, *, /         Basic arithmetic
 *   %                  Modulo
 *   ^, **              Power
 *   ( )                Grouping
 *   sqrt(x)            Square root
 *   abs(x)             Absolute value
 *   floor(x)           Floor
 *   ceil(x)            Ceiling
 *   round(x)           Round
 *   sin(x), cos(x)     Trigonometry (radians)
 *   tan(x)             Tangent
 *   log(x)             Natural log
 *   log10(x)           Base-10 log
 *   exp(x)             e^x
 *   pi                 Pi constant
 *   e                  Euler's number
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: GNU bc (simplified)
 * Supported flags:
 *   -l            Load math library (enables decimals, default scale=20)
 *   --help        Display help text and exit
 *
 * EXIT CODES
 * ==========
 * 0 - Success
 * 1 - Syntax error or invalid expression
 *
 * @module rom/bin/bc
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { println, eprintln, exit, getargs, recv, send, respond } from '@rom/lib/process/index.js';
import { parseArgs } from '@rom/lib/args';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

// =============================================================================
// HELP TEXT
// =============================================================================

const HELP_TEXT = `
Usage: bc [OPTIONS] [EXPRESSION]

Arbitrary precision calculator.

Options:
  -l          Load math library (scale=20)
  --help      Display this help and exit

Operators:
  + - * / %   Arithmetic
  ^ **        Power
  ( )         Grouping

Functions:
  sqrt(x)     Square root
  abs(x)      Absolute value
  floor(x)    Floor
  ceil(x)     Ceiling
  round(x)    Round
  sin(x)      Sine (radians)
  cos(x)      Cosine (radians)
  tan(x)      Tangent (radians)
  log(x)      Natural logarithm
  log10(x)    Base-10 logarithm
  exp(x)      e^x

Constants:
  pi          3.14159...
  e           2.71828...

Examples:
  bc "2 + 2"              Basic arithmetic
  bc "sqrt(16)"           Square root
  bc "(10 + 5) * 2"       Grouping
  bc -l "scale=4; 10/3"   Decimal precision
`.trim();

// =============================================================================
// ARGUMENT SPECS
// =============================================================================

const ARG_SPECS = {
    mathLib: { short: 'l', desc: 'Load math library (scale=20)' },
    help: { long: 'help', desc: 'Display help and exit' },
};

// =============================================================================
// EXPRESSION EVALUATION
// =============================================================================

/**
 * Evaluate a mathematical expression.
 */
function evaluate(expr: string, _scale: number): number | undefined {
    // Replace constants
    let processed = expr
        .replace(/\bpi\b/gi, String(Math.PI))
        .replace(/\be\b/g, String(Math.E));

    // Replace ^ with ** for power
    processed = processed.replace(/\^/g, '**');

    // Replace math functions
    processed = processed
        .replace(/\bsqrt\s*\(/g, 'Math.sqrt(')
        .replace(/\babs\s*\(/g, 'Math.abs(')
        .replace(/\bfloor\s*\(/g, 'Math.floor(')
        .replace(/\bceil\s*\(/g, 'Math.ceil(')
        .replace(/\bround\s*\(/g, 'Math.round(')
        .replace(/\bsin\s*\(/g, 'Math.sin(')
        .replace(/\bcos\s*\(/g, 'Math.cos(')
        .replace(/\btan\s*\(/g, 'Math.tan(')
        .replace(/\blog10\s*\(/g, 'Math.log10(')
        .replace(/\blog\s*\(/g, 'Math.log(')
        .replace(/\bexp\s*\(/g, 'Math.exp(')
        .replace(/\bpow\s*\(/g, 'Math.pow(');

    // Remove scale=N prefix if present after semicolon
    processed = processed.replace(/scale\s*=\s*\d+\s*;\s*/g, '');

    // Validate: only allow safe characters
    if (!/^[\d\s+\-*/%().Math,sqrtabflorceingtaxpow]+$/.test(processed)) {
        throw new Error(`invalid expression: ${expr}`);
    }

    // Evaluate using Function (safer than eval, no access to scope)
    try {
        const fn = new Function(`"use strict"; return (${processed});`);
        const result = fn();

        if (typeof result === 'number' && !isNaN(result) && isFinite(result)) {
            return result;
        }
        else if (typeof result === 'number') {
            throw new Error('result is not a finite number');
        }

        return undefined;
    }
    catch {
        throw new Error(`invalid expression: ${expr}`);
    }
}

/**
 * Format number with given scale.
 */
function formatNumber(num: number, scale: number): string {
    if (scale === 0) {
        return String(Math.trunc(num));
    }

    // Handle very small numbers
    if (Math.abs(num) < 1e-10 && num !== 0) {
        return num.toExponential(scale);
    }

    const fixed = num.toFixed(scale);

    // Remove trailing zeros after decimal point
    return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS, { stopAtFirstPositional: true });

    if (parsed.flags.help) {
        await println(HELP_TEXT);

        return exit(EXIT_SUCCESS);
    }

    // Determine expression source
    let expression: string;

    if (parsed.positional.length > 0) {
        expression = parsed.positional.join(' ');
    }
    else {
        // Read from stdin
        const lines: string[] = [];

        for await (const msg of recv(0)) {
            if (msg.op === 'item') {
                const data = msg.data as { text?: string } | undefined;
                const text = data?.text ?? '';

                if (text) {
                    lines.push(text);
                }
            }
        }

        expression = lines.join('\n').trim();
    }

    if (!expression) {
        await eprintln('bc: no expression provided');

        return exit(EXIT_FAILURE);
    }

    // Process lines
    const mathLib = parsed.flags.mathLib === true;
    let scale = mathLib ? 20 : 0;
    const exprLines = expression.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    for (let line of exprLines) {
        // Handle scale setting
        const scaleMatch = line.match(/scale\s*=\s*(\d+)/);

        if (scaleMatch && scaleMatch[1]) {
            scale = parseInt(scaleMatch[1], 10);
            line = line.replace(/scale\s*=\s*\d+\s*;?\s*/, '').trim();
            if (!line) {
                continue;
            }
        }

        // Skip assignment-only lines
        if (/^[a-z_]\w*\s*=/.test(line) && !line.includes(';')) {
            continue;
        }

        try {
            const result = evaluate(line, scale);

            if (result !== undefined) {
                await println(formatNumber(result, scale));
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'syntax error';

            await eprintln(`bc: ${message}`);

            return exit(EXIT_FAILURE);
        }
    }

    await send(1, respond.done());

    return exit(EXIT_SUCCESS);
}
