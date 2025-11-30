/**
 * Shell control flow commands: if, then, else, elif, fi
 *
 * Usage:
 *   if <condition>
 *   then
 *       <commands>
 *   elif <condition>
 *   then
 *       <commands>
 *   else
 *       <commands>
 *   fi
 *
 * The condition is typically a test command:
 *   if [ -d "$HOME/bin" ]
 *   if test -f /etc/passwd
 *   if grep -q pattern file
 *
 * Exit code 0 = true, non-zero = false
 */

import type { CommandHandler } from './shared.js';
import { executeLine } from '../executor.js';

/**
 * Ensure conditionalStack is initialized (for cached sessions from before this field was added)
 */
function ensureStack(session: { conditionalStack?: import('../types.js').ConditionalContext[] }): import('../types.js').ConditionalContext[] {
    if (!session.conditionalStack) {
        session.conditionalStack = [];
    }
    return session.conditionalStack;
}

/**
 * Check if we should execute commands in current conditional context
 */
export function shouldExecute(session: { conditionalStack?: import('../types.js').ConditionalContext[] }): boolean {
    const stack = ensureStack(session);
    if (stack.length === 0) {
        return true;
    }

    // Check all contexts in the stack - all must allow execution
    for (const ctx of stack) {
        // If we're skipping nested blocks, don't execute
        if (ctx.skipDepth > 0) {
            return false;
        }

        // In 'condition' phase, we're evaluating the condition - execute it
        if (ctx.branch === 'condition') {
            return true;
        }

        // In 'then' branch, execute only if condition was true (0) and not already matched
        if (ctx.branch === 'then') {
            if (ctx.condition !== 0 || ctx.matched) {
                return false;
            }
        }

        // In 'else' branch, execute only if no previous branch matched
        if (ctx.branch === 'else') {
            if (ctx.matched) {
                return false;
            }
        }
    }

    return true;
}

/**
 * if - Start a conditional block
 *
 * Syntax: if <command> [args...]
 * The command is executed and its exit code becomes the condition.
 */
export const if_: CommandHandler = async (session, fs, args, io) => {
    const stack = ensureStack(session);
    const ctx = stack.at(-1);

    // If we're in a non-executing branch, just track nesting
    if (ctx && !shouldExecute(session)) {
        ctx.skipDepth++;
        return 0;
    }

    // Push new conditional context
    stack.push({
        type: 'if',
        condition: 1, // Default to false, will be set by condition evaluation
        branch: 'condition',
        matched: false,
        skipDepth: 0,
    });

    // If no condition provided, treat as false
    if (args.length === 0) {
        stack.at(-1)!.condition = 1;
        return 0;
    }

    // Execute the condition command
    const conditionLine = args.join(' ');
    const exitCode = await executeLine(session, conditionLine, io, {
        addToHistory: false,
        useTransaction: false,
        fs: fs ?? undefined,
    });

    stack.at(-1)!.condition = exitCode;
    return 0;
};

/**
 * then - Start the "then" branch
 */
export const then: CommandHandler = async (session, _fs, _args, io) => {
    const stack = ensureStack(session);
    const ctx = stack.at(-1);

    if (!ctx) {
        io?.stderr?.write('then: not in an if block\n');
        return 1;
    }

    // If we're skipping nested blocks, ignore
    if (ctx.skipDepth > 0) {
        return 0;
    }

    if (ctx.branch !== 'condition') {
        io?.stderr?.write('then: unexpected then\n');
        return 1;
    }

    ctx.branch = 'then';

    // Mark as matched if condition was true
    if (ctx.condition === 0) {
        ctx.matched = true;
    }

    return 0;
};

/**
 * else - Start the "else" branch
 */
export const else_: CommandHandler = async (session, _fs, _args, io) => {
    const stack = ensureStack(session);
    const ctx = stack.at(-1);

    if (!ctx) {
        io?.stderr?.write('else: not in an if block\n');
        return 1;
    }

    // If we're skipping nested blocks, ignore
    if (ctx.skipDepth > 0) {
        return 0;
    }

    if (ctx.branch !== 'then') {
        io?.stderr?.write('else: unexpected else\n');
        return 1;
    }

    ctx.branch = 'else';
    return 0;
};

/**
 * elif - Start an "elif" branch (else if)
 *
 * Syntax: elif <command> [args...]
 */
export const elif: CommandHandler = async (session, fs, args, io) => {
    const stack = ensureStack(session);
    const ctx = stack.at(-1);

    if (!ctx) {
        io?.stderr?.write('elif: not in an if block\n');
        return 1;
    }

    // If we're skipping nested blocks, ignore
    if (ctx.skipDepth > 0) {
        return 0;
    }

    if (ctx.branch !== 'then') {
        io?.stderr?.write('elif: unexpected elif\n');
        return 1;
    }

    // If a previous branch already matched, don't evaluate this condition
    if (ctx.matched) {
        ctx.branch = 'condition'; // Will transition to 'then' on next 'then'
        ctx.condition = 1; // Force false
        return 0;
    }

    // Evaluate the new condition
    ctx.branch = 'condition';

    if (args.length === 0) {
        ctx.condition = 1;
        return 0;
    }

    const conditionLine = args.join(' ');
    const exitCode = await executeLine(session, conditionLine, io, {
        addToHistory: false,
        useTransaction: false,
        fs: fs ?? undefined,
    });

    ctx.condition = exitCode;
    return 0;
};

/**
 * fi - End the conditional block
 */
export const fi: CommandHandler = async (session, _fs, _args, io) => {
    const stack = ensureStack(session);
    const ctx = stack.at(-1);

    if (!ctx) {
        io?.stderr?.write('fi: not in an if block\n');
        return 1;
    }

    // If we're skipping nested blocks, decrement depth
    if (ctx.skipDepth > 0) {
        ctx.skipDepth--;
        return 0;
    }

    // Pop the conditional context
    stack.pop();
    return 0;
};
