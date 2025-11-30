/**
 * test - Evaluate conditional expressions
 *
 * Usage:
 *   test <expression>
 *   [ <expression> ]
 *
 * File tests:
 *   -e FILE    FILE exists
 *   -f FILE    FILE exists and is a regular file
 *   -d FILE    FILE exists and is a directory
 *   -s FILE    FILE exists and has size > 0
 *   -r FILE    FILE exists and is readable
 *   -w FILE    FILE exists and is writable
 *   -x FILE    FILE exists and is executable
 *   -L FILE    FILE exists and is a symbolic link
 *
 * String tests:
 *   -z STRING  STRING has zero length
 *   -n STRING  STRING has non-zero length
 *   STRING     STRING is not empty (same as -n)
 *   S1 = S2    strings are equal
 *   S1 != S2   strings are not equal
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
 * Exit status:
 *   0 if expression is true
 *   1 if expression is false
 *   2 if error
 *
 * Examples:
 *   test -f /etc/passwd && echo "exists"
 *   test -d /tmp || mkdir /tmp
 *   [ -z "$VAR" ] && echo "VAR is empty"
 *   [ "$A" = "$B" ] && echo "equal"
 */

import type { CommandHandler } from './shared.js';
import { resolvePath } from '../parser.js';

export const test: CommandHandler = async (session, fs, args, io) => {
    // Handle [ command - strip trailing ]
    let testArgs = [...args];
    if (testArgs[testArgs.length - 1] === ']') {
        testArgs = testArgs.slice(0, -1);
    }

    // No args = false
    if (testArgs.length === 0) {
        return 1;
    }

    try {
        const result = await evaluateExpression(session, fs, testArgs);
        return result ? 0 : 1;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`test: ${message}\n`);
        return 2;
    }
};

/**
 * Evaluate a test expression
 */
async function evaluateExpression(
    session: { cwd: string },
    fs: { stat: (path: string) => Promise<{ type: string; mode: number; size: number }> } | null,
    args: string[]
): Promise<boolean> {
    // Handle negation
    if (args[0] === '!') {
        if (args.length === 1) {
            throw new Error('missing argument after \'!\'');
        }
        return !(await evaluateExpression(session, fs, args.slice(1)));
    }

    // Single argument: true if non-empty string
    if (args.length === 1) {
        return args[0].length > 0;
    }

    // Two arguments: unary operators
    if (args.length === 2) {
        const [op, operand] = args;
        return evaluateUnary(session, fs, op, operand);
    }

    // Three arguments: binary operators
    if (args.length === 3) {
        const [left, op, right] = args;
        return evaluateBinary(left, op, right);
    }

    throw new Error('too many arguments');
}

/**
 * Evaluate unary test operators
 */
async function evaluateUnary(
    session: { cwd: string },
    fs: { stat: (path: string) => Promise<{ type: string; mode: number; size: number }> } | null,
    op: string,
    operand: string
): Promise<boolean> {
    // String tests
    switch (op) {
        case '-z':
            return operand.length === 0;
        case '-n':
            return operand.length > 0;
    }

    // File tests require filesystem
    if (!fs) {
        throw new Error('filesystem not available');
    }

    const path = resolvePath(session.cwd, operand);

    switch (op) {
        case '-e': {
            // Exists (any type)
            try {
                await fs.stat(path);
                return true;
            } catch {
                return false;
            }
        }

        case '-f': {
            // Regular file
            try {
                const stat = await fs.stat(path);
                return stat.type === 'file';
            } catch {
                return false;
            }
        }

        case '-d': {
            // Directory
            try {
                const stat = await fs.stat(path);
                return stat.type === 'directory';
            } catch {
                return false;
            }
        }

        case '-L':
        case '-h': {
            // Symbolic link
            try {
                const stat = await fs.stat(path);
                return stat.type === 'symlink';
            } catch {
                return false;
            }
        }

        case '-s': {
            // Exists and size > 0
            try {
                const stat = await fs.stat(path);
                return stat.size > 0;
            } catch {
                return false;
            }
        }

        case '-r': {
            // Readable (check read permission)
            try {
                const stat = await fs.stat(path);
                return (stat.mode & 0o444) !== 0;
            } catch {
                return false;
            }
        }

        case '-w': {
            // Writable (check write permission)
            try {
                const stat = await fs.stat(path);
                return (stat.mode & 0o222) !== 0;
            } catch {
                return false;
            }
        }

        case '-x': {
            // Executable (check execute permission)
            try {
                const stat = await fs.stat(path);
                return (stat.mode & 0o111) !== 0;
            } catch {
                return false;
            }
        }

        default:
            throw new Error(`unknown operator: ${op}`);
    }
}

/**
 * Evaluate binary test operators
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

// Alias for [ command
export const bracket = test;
