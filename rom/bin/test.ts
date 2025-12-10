/**
 * test - Evaluate conditional expressions
 *
 * SYNOPSIS
 * ========
 * test EXPRESSION
 * [ EXPRESSION ]
 *
 * DESCRIPTION
 * ===========
 * Evaluate a conditional expression and exit with status 0 (true) or 1 (false).
 * Used extensively in shell scripts for conditional logic.
 *
 * File tests:
 *   -e FILE    FILE exists
 *   -f FILE    FILE exists and is a regular file
 *   -d FILE    FILE exists and is a directory
 *   -s FILE    FILE exists and has size > 0
 *   -L FILE    FILE exists and is a symbolic link
 *
 * String tests:
 *   -z STRING  STRING has zero length
 *   -n STRING  STRING has non-zero length
 *   STRING     STRING is not empty (same as -n)
 *   S1 = S2    Strings are equal
 *   S1 != S2   Strings are not equal
 *
 * Numeric tests:
 *   N1 -eq N2  N1 equals N2
 *   N1 -ne N2  N1 not equal to N2
 *   N1 -lt N2  N1 less than N2
 *   N1 -le N2  N1 less than or equal to N2
 *   N1 -gt N2  N1 greater than N2
 *   N1 -ge N2  N1 greater than or equal to N2
 *
 * Logical operators:
 *   ! EXPR     EXPR is false
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: POSIX test / GNU coreutils test
 * Supported: Most common file, string, and numeric tests
 * Unsupported: -a (and), -o (or), compound expressions
 *
 * EXIT CODES
 * ==========
 * 0 - Expression is true
 * 1 - Expression is false
 * 2 - Syntax error
 *
 * @module rom/bin/test
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { eprintln, exit, getargs, call } from '@rom/lib/process/index.js';
import { resolvePath } from '@rom/lib/path';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXIT_TRUE = 0;
const EXIT_FALSE = 1;
const EXIT_ERROR = 2;

// =============================================================================
// FILE TESTS
// =============================================================================

/**
 * Perform a file test using file:stat syscall.
 */
async function fileTest(op: string, path: string, cwd: string): Promise<boolean> {
    const resolved = resolvePath(cwd, path);

    try {
        const result = await call('file:stat', resolved);

        // Result is a stat object with type, size, mode, etc.
        if (!result || typeof result !== 'object') {
            return false;
        }

        const stat = result as { type?: string; size?: number };

        switch (op) {
            case '-e':
                // Exists (any type)
                return true;

            case '-f':
                // Regular file
                return stat.type === 'file';

            case '-d':
                // Directory
                return stat.type === 'directory';

            case '-L':
            case '-h':
                // Symbolic link
                return stat.type === 'symlink';

            case '-s':
                // Exists and size > 0
                return (stat.size ?? 0) > 0;

            default:
                return false;
        }
    }
    catch {
        // File doesn't exist or error accessing
        return false;
    }
}

// =============================================================================
// EXPRESSION EVALUATION
// =============================================================================

/**
 * Evaluate unary test operators.
 */
async function evaluateUnary(op: string, operand: string, cwd: string): Promise<boolean> {
    // String tests
    switch (op) {
        case '-z':
            return operand.length === 0;
        case '-n':
            return operand.length > 0;
    }

    // File tests
    if (['-e', '-f', '-d', '-s', '-L', '-h'].includes(op)) {
        return fileTest(op, operand, cwd);
    }

    throw new Error(`unknown operator: ${op}`);
}

/**
 * Evaluate binary test operators.
 */
function evaluateBinary(left: string, op: string, right: string): boolean {
    switch (op) {
        // String comparisons
        case '=':
        case '==':
            return left === right;
        case '!=':
            return left !== right;

        // Numeric comparisons
        case '-eq': {
            const l = parseInt(left, 10);
            const r = parseInt(right, 10);
            if (isNaN(l) || isNaN(r)) {
                throw new Error('integer expression expected');
            }
            return l === r;
        }
        case '-ne': {
            const l = parseInt(left, 10);
            const r = parseInt(right, 10);
            if (isNaN(l) || isNaN(r)) {
                throw new Error('integer expression expected');
            }
            return l !== r;
        }
        case '-lt': {
            const l = parseInt(left, 10);
            const r = parseInt(right, 10);
            if (isNaN(l) || isNaN(r)) {
                throw new Error('integer expression expected');
            }
            return l < r;
        }
        case '-le': {
            const l = parseInt(left, 10);
            const r = parseInt(right, 10);
            if (isNaN(l) || isNaN(r)) {
                throw new Error('integer expression expected');
            }
            return l <= r;
        }
        case '-gt': {
            const l = parseInt(left, 10);
            const r = parseInt(right, 10);
            if (isNaN(l) || isNaN(r)) {
                throw new Error('integer expression expected');
            }
            return l > r;
        }
        case '-ge': {
            const l = parseInt(left, 10);
            const r = parseInt(right, 10);
            if (isNaN(l) || isNaN(r)) {
                throw new Error('integer expression expected');
            }
            return l >= r;
        }

        default:
            throw new Error(`unknown operator: ${op}`);
    }
}

/**
 * Evaluate a test expression.
 */
async function evaluateExpression(testArgs: string[], cwd: string): Promise<boolean> {
    // Handle negation
    if (testArgs[0] === '!') {
        if (testArgs.length === 1) {
            throw new Error("missing argument after '!'");
        }
        return !(await evaluateExpression(testArgs.slice(1), cwd));
    }

    // Single argument: true if non-empty string
    if (testArgs.length === 1) {
        return (testArgs[0] ?? '').length > 0;
    }

    // Two arguments: unary operators
    if (testArgs.length === 2) {
        const [op, operand] = testArgs;
        return evaluateUnary(op!, operand!, cwd);
    }

    // Three arguments: binary operators
    if (testArgs.length === 3) {
        const [left, op, right] = testArgs;
        return evaluateBinary(left!, op!, right!);
    }

    throw new Error('too many arguments');
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const args = await getargs();

    // Skip program name
    let testArgs = args.slice(1);

    // Handle [ command - strip trailing ]
    if (testArgs[testArgs.length - 1] === ']') {
        testArgs = testArgs.slice(0, -1);
    }

    // No args = false
    if (testArgs.length === 0) {
        return exit(EXIT_FALSE);
    }

    // Get cwd for file tests
    const cwd = process.cwd();

    try {
        const result = await evaluateExpression(testArgs, cwd);
        return exit(result ? EXIT_TRUE : EXIT_FALSE);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await eprintln(`test: ${message}`);
        return exit(EXIT_ERROR);
    }
}
