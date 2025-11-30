/**
 * bc - Arbitrary precision calculator
 *
 * Usage:
 *   bc [expression]
 *   echo "expression" | bc
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
 * Options:
 *   -l                 Load math library (enables decimals, default scale=20)
 *
 * Examples:
 *   bc "2 + 2"
 *   bc "sqrt(16)"
 *   bc "(10 + 5) * 2"
 *   echo "scale=4; 10/3" | bc
 */

import type { CommandHandler } from './shared.js';

export const bc: CommandHandler = async (_session, _fs, args, io) => {
    let mathLib = false;
    let expression: string | undefined;

    // Parse arguments
    for (const arg of args) {
        if (arg === '-l') {
            mathLib = true;
        } else if (!arg.startsWith('-')) {
            expression = arg;
        }
    }

    // Read from stdin if no expression provided
    if (!expression) {
        let buffer = '';
        for await (const chunk of io.stdin) {
            buffer += chunk.toString();
        }
        expression = buffer.trim();
    }

    if (!expression) {
        io.stderr.write('bc: no expression provided\n');
        return 1;
    }

    // Process each line/expression
    const lines = expression.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    let scale = mathLib ? 20 : 0;

    for (let line of lines) {
        // Handle scale setting (can be inline: "scale=2; expr" or standalone)
        const scaleMatch = line.match(/scale\s*=\s*(\d+)/);
        if (scaleMatch) {
            scale = parseInt(scaleMatch[1], 10);
            // Remove scale assignment from line and continue processing
            line = line.replace(/scale\s*=\s*\d+\s*;?\s*/, '').trim();
            if (!line) continue;
        }

        // Skip assignment-only lines for now
        if (/^[a-z_]\w*\s*=/.test(line) && !line.includes(';')) {
            continue;
        }

        try {
            const result = evaluate(line, scale);
            if (result !== undefined) {
                io.stdout.write(formatNumber(result, scale) + '\n');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'syntax error';
            io.stderr.write(`bc: ${message}\n`);
            return 1;
        }
    }

    return 0;
};

/**
 * Evaluate a mathematical expression
 */
function evaluate(expr: string, scale: number): number | undefined {
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
        } else if (typeof result === 'number') {
            throw new Error('result is not a finite number');
        }
        return undefined;
    } catch {
        throw new Error(`invalid expression: ${expr}`);
    }
}

/**
 * Format number with given scale
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
    // Remove trailing zeros after decimal point, but keep at least one decimal place if scale > 0
    return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// Also export as calc alias
export const calc = bc;
