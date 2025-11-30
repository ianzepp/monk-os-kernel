/**
 * jq Evaluator - Executes AST against JSON data
 *
 * Evaluates parsed jq expressions against input data, producing output values.
 * jq expressions can produce multiple outputs (e.g., .[] on an array), so
 * all evaluation functions return arrays of results.
 */

import type { ASTNode, JqContext } from './types.js';
import { builtins } from './builtins.js';

/**
 * Evaluate a jq AST node against input data
 */
export function evaluate(node: ASTNode, ctx: JqContext): any[] {
    switch (node.type) {
        case 'identity':
            return [ctx.input];

        case 'literal':
            return [node.value];

        case 'field':
            return evaluateField(node, ctx);

        case 'index':
            return evaluateIndex(node, ctx);

        case 'slice':
            return evaluateSlice(node, ctx);

        case 'iterator':
            return evaluateIterator(node, ctx);

        case 'pipe':
            return evaluatePipe(node, ctx);

        case 'array':
            return evaluateArray(node, ctx);

        case 'object':
            return evaluateObject(node, ctx);

        case 'binary':
            return evaluateBinary(node, ctx);

        case 'unary':
            return evaluateUnary(node, ctx);

        case 'function':
            return evaluateFunction(node, ctx);

        case 'conditional':
            return evaluateConditional(node, ctx);

        case 'try':
            return evaluateTry(node, ctx);

        case 'recursive':
            return evaluateRecursive(ctx);

        case 'optional':
            return evaluateOptional(node, ctx);

        case 'variable':
            return evaluateVariable(node, ctx);

        case 'binding':
            return evaluateBinding(node, ctx);

        default:
            throw new Error(`Unknown node type: ${(node as any).type}`);
    }
}

// =============================================================================
// Node evaluators
// =============================================================================

function evaluateField(node: { type: 'field'; name: string; optional: boolean }, ctx: JqContext): any[] {
    const input = ctx.input;

    if (input === null || input === undefined) {
        if (node.optional) return [];
        return [null];
    }

    if (typeof input !== 'object') {
        if (node.optional) return [];
        throw new Error(`Cannot index ${typeof input} with string "${node.name}"`);
    }

    const value = input[node.name];
    if (value === undefined) {
        if (node.optional) return [];
        return [null];
    }

    return [value];
}

function evaluateIndex(node: { type: 'index'; index: ASTNode; optional: boolean }, ctx: JqContext): any[] {
    const indices = evaluate(node.index, ctx);
    const results: any[] = [];

    for (const index of indices) {
        const input = ctx.input;

        if (input === null || input === undefined) {
            if (node.optional) continue;
            results.push(null);
            continue;
        }

        if (Array.isArray(input)) {
            const idx = typeof index === 'number' ? (index < 0 ? input.length + index : index) : index;
            if (idx >= 0 && idx < input.length) {
                results.push(input[idx]);
            } else if (!node.optional) {
                results.push(null);
            }
        } else if (typeof input === 'object') {
            const value = input[index];
            if (value !== undefined) {
                results.push(value);
            } else if (!node.optional) {
                results.push(null);
            }
        } else if (typeof input === 'string') {
            const idx = typeof index === 'number' ? (index < 0 ? input.length + index : index) : parseInt(index);
            if (idx >= 0 && idx < input.length) {
                results.push(input[idx]);
            } else if (!node.optional) {
                results.push(null);
            }
        } else if (!node.optional) {
            throw new Error(`Cannot index ${typeof input}`);
        }
    }

    return results;
}

function evaluateSlice(node: { type: 'slice'; start: ASTNode | null; end: ASTNode | null }, ctx: JqContext): any[] {
    const input = ctx.input;

    if (!Array.isArray(input) && typeof input !== 'string') {
        throw new Error(`Cannot slice ${typeof input}`);
    }

    const len = input.length;
    let start = 0;
    let end = len;

    if (node.start) {
        const starts = evaluate(node.start, ctx);
        start = starts[0] ?? 0;
        if (start < 0) start = len + start;
    }

    if (node.end) {
        const ends = evaluate(node.end, ctx);
        end = ends[0] ?? len;
        if (end < 0) end = len + end;
    }

    return [input.slice(start, end)];
}

function evaluateIterator(node: { type: 'iterator'; optional: boolean }, ctx: JqContext): any[] {
    const input = ctx.input;

    if (input === null || input === undefined) {
        if (node.optional) return [];
        throw new Error('Cannot iterate over null');
    }

    if (Array.isArray(input)) {
        return input;
    }

    if (typeof input === 'object') {
        return Object.values(input);
    }

    if (node.optional) return [];
    throw new Error(`Cannot iterate over ${typeof input}`);
}

function evaluatePipe(node: { type: 'pipe'; left: ASTNode; right: ASTNode }, ctx: JqContext): any[] {
    const leftResults = evaluate(node.left, ctx);
    const results: any[] = [];

    for (const leftValue of leftResults) {
        const rightResults = evaluate(node.right, { ...ctx, input: leftValue });
        results.push(...rightResults);
    }

    return results;
}

function evaluateArray(node: { type: 'array'; elements: ASTNode[] }, ctx: JqContext): any[] {
    if (node.elements.length === 0) {
        return [[]];
    }

    // Collect all outputs from all elements
    const result: any[] = [];
    for (const element of node.elements) {
        const values = evaluate(element, ctx);
        result.push(...values);
    }

    return [result];
}

function evaluateObject(node: { type: 'object'; entries: Array<{ key: ASTNode | string; value: ASTNode }> }, ctx: JqContext): any[] {
    const result: Record<string, any> = {};

    for (const entry of node.entries) {
        let key: string;
        if (typeof entry.key === 'string') {
            key = entry.key;
        } else {
            const keys = evaluate(entry.key, ctx);
            key = String(keys[0]);
        }

        const values = evaluate(entry.value, ctx);
        result[key] = values.length > 0 ? values[0] : null;
    }

    return [result];
}

function evaluateBinary(node: { type: 'binary'; operator: string; left: ASTNode; right: ASTNode }, ctx: JqContext): any[] {
    const leftResults = evaluate(node.left, ctx);
    const rightResults = evaluate(node.right, ctx);

    // For binary ops, we typically use first result from each side
    const left = leftResults[0];
    const right = rightResults[0];

    switch (node.operator) {
        case '+':
            if (typeof left === 'number' && typeof right === 'number') return [left + right];
            if (typeof left === 'string' && typeof right === 'string') return [left + right];
            if (Array.isArray(left) && Array.isArray(right)) return [[...left, ...right]];
            if (typeof left === 'object' && typeof right === 'object' && left && right) {
                return [{ ...left, ...right }];
            }
            if (left === null) return [right];
            if (right === null) return [left];
            throw new Error(`Cannot add ${typeof left} and ${typeof right}`);

        case '-':
            if (typeof left === 'number' && typeof right === 'number') return [left - right];
            if (Array.isArray(left) && Array.isArray(right)) {
                return [left.filter(v => !right.some(r => JSON.stringify(r) === JSON.stringify(v)))];
            }
            throw new Error(`Cannot subtract ${typeof right} from ${typeof left}`);

        case '*':
            if (typeof left === 'number' && typeof right === 'number') return [left * right];
            if (typeof left === 'string' && typeof right === 'number') return [left.repeat(right)];
            if (typeof left === 'object' && typeof right === 'object' && left && right && !Array.isArray(left) && !Array.isArray(right)) {
                // Object multiplication (recursive merge)
                return [deepMerge(left, right)];
            }
            throw new Error(`Cannot multiply ${typeof left} and ${typeof right}`);

        case '/':
            if (typeof left === 'number' && typeof right === 'number') {
                if (right === 0) throw new Error('Division by zero');
                return [left / right];
            }
            if (typeof left === 'string' && typeof right === 'string') {
                return [left.split(right)];
            }
            throw new Error(`Cannot divide ${typeof left} by ${typeof right}`);

        case '%':
            if (typeof left === 'number' && typeof right === 'number') {
                if (right === 0) throw new Error('Modulo by zero');
                return [left % right];
            }
            throw new Error(`Cannot modulo ${typeof left} by ${typeof right}`);

        case '==':
            return [deepEqual(left, right)];

        case '!=':
            return [!deepEqual(left, right)];

        case '<':
            return [left < right];

        case '<=':
            return [left <= right];

        case '>':
            return [left > right];

        case '>=':
            return [left >= right];

        case 'and':
            return [left && right ? right : false];

        case 'or':
            return [left || right];

        default:
            throw new Error(`Unknown operator: ${node.operator}`);
    }
}

function evaluateUnary(node: { type: 'unary'; operator: string; operand: ASTNode }, ctx: JqContext): any[] {
    const values = evaluate(node.operand, ctx);
    const value = values[0];

    switch (node.operator) {
        case '-':
            if (typeof value === 'number') return [-value];
            throw new Error(`Cannot negate ${typeof value}`);

        case 'not':
            return [!value];

        default:
            throw new Error(`Unknown unary operator: ${node.operator}`);
    }
}

function evaluateFunction(node: { type: 'function'; name: string; args: ASTNode[] }, ctx: JqContext): any[] {
    const fn = builtins[node.name];
    if (!fn) {
        throw new Error(`Unknown function: ${node.name}`);
    }

    return fn(ctx, node.args, evaluate);
}

function evaluateConditional(node: { type: 'conditional'; condition: ASTNode; then: ASTNode; else: ASTNode | null }, ctx: JqContext): any[] {
    const conditions = evaluate(node.condition, ctx);

    if (conditions.length > 0 && conditions[0]) {
        return evaluate(node.then, ctx);
    } else if (node.else) {
        return evaluate(node.else, ctx);
    }

    return [null];
}

function evaluateTry(node: { type: 'try'; expr: ASTNode; catch: ASTNode | null }, ctx: JqContext): any[] {
    try {
        return evaluate(node.expr, ctx);
    } catch {
        if (node.catch) {
            return evaluate(node.catch, ctx);
        }
        return [];
    }
}

function evaluateRecursive(ctx: JqContext): any[] {
    const results: any[] = [];
    const seen = new Set<string>();

    function recurse(value: any): void {
        const key = JSON.stringify(value);
        if (seen.has(key)) return;
        seen.add(key);

        results.push(value);

        if (Array.isArray(value)) {
            for (const item of value) {
                recurse(item);
            }
        } else if (typeof value === 'object' && value !== null) {
            for (const v of Object.values(value)) {
                recurse(v);
            }
        }
    }

    recurse(ctx.input);
    return results;
}

function evaluateOptional(node: { type: 'optional'; expr: ASTNode }, ctx: JqContext): any[] {
    try {
        return evaluate(node.expr, ctx);
    } catch {
        return [];
    }
}

function evaluateVariable(node: { type: 'variable'; name: string }, ctx: JqContext): any[] {
    if (ctx.variables.has(node.name)) {
        return [ctx.variables.get(node.name)];
    }
    throw new Error(`Undefined variable: $${node.name}`);
}

function evaluateBinding(node: { type: 'binding'; expr: ASTNode; variable: string; body: ASTNode }, ctx: JqContext): any[] {
    const values = evaluate(node.expr, ctx);
    const results: any[] = [];

    for (const value of values) {
        const newCtx = {
            ...ctx,
            variables: new Map(ctx.variables).set(node.variable, value)
        };
        results.push(...evaluate(node.body, newCtx));
    }

    return results;
}

// =============================================================================
// Helpers
// =============================================================================

function deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;

    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, b[i]));
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => deepEqual(a[k], b[k]));
}

function deepMerge(a: any, b: any): any {
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return b;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return b;
    }

    const result = { ...a };
    for (const key of Object.keys(b)) {
        if (key in a && typeof a[key] === 'object' && typeof b[key] === 'object') {
            result[key] = deepMerge(a[key], b[key]);
        } else {
            result[key] = b[key];
        }
    }
    return result;
}
