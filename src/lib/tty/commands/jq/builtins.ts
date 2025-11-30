/**
 * jq Built-in Functions
 *
 * Each function takes the evaluation context, arguments (AST nodes), and
 * the evaluate function for evaluating arguments. Returns an array of
 * output values (jq functions can produce multiple outputs).
 *
 * Easy to extend: just add new entries to the `builtins` object.
 */

import type { BuiltinRegistry, BuiltinFn, JqContext, ASTNode } from './types.js';

// =============================================================================
// Helper functions
// =============================================================================

function ensureArray(val: any): any[] {
    return Array.isArray(val) ? val : [val];
}

function deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
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

// =============================================================================
// Built-in function implementations
// =============================================================================

export const builtins: BuiltinRegistry = {
    // =========================================================================
    // Type functions
    // =========================================================================

    type: (ctx) => {
        const val = ctx.input;
        if (val === null) return ['null'];
        if (Array.isArray(val)) return ['array'];
        return [typeof val];
    },

    isnull: (ctx) => [ctx.input === null],
    isboolean: (ctx) => [typeof ctx.input === 'boolean'],
    isnumber: (ctx) => [typeof ctx.input === 'number'],
    isstring: (ctx) => [typeof ctx.input === 'string'],
    isarray: (ctx) => [Array.isArray(ctx.input)],
    isobject: (ctx) => [typeof ctx.input === 'object' && ctx.input !== null && !Array.isArray(ctx.input)],

    // =========================================================================
    // Boolean functions
    // =========================================================================

    not: (ctx) => [!ctx.input],

    // =========================================================================
    // Length and counting
    // =========================================================================

    length: (ctx) => {
        const val = ctx.input;
        if (val === null) return [0];
        if (typeof val === 'string') return [val.length];
        if (Array.isArray(val)) return [val.length];
        if (typeof val === 'object') return [Object.keys(val).length];
        return [1];
    },

    // =========================================================================
    // Object functions
    // =========================================================================

    keys: (ctx) => {
        const val = ctx.input;
        if (Array.isArray(val)) {
            return [val.map((_, i) => i)];
        }
        if (typeof val === 'object' && val !== null) {
            return [Object.keys(val).sort()];
        }
        throw new Error('keys requires an object or array');
    },

    keys_unsorted: (ctx) => {
        const val = ctx.input;
        if (Array.isArray(val)) {
            return [val.map((_, i) => i)];
        }
        if (typeof val === 'object' && val !== null) {
            return [Object.keys(val)];
        }
        throw new Error('keys_unsorted requires an object or array');
    },

    values: (ctx) => {
        const val = ctx.input;
        if (Array.isArray(val)) return [val];
        if (typeof val === 'object' && val !== null) {
            return [Object.values(val)];
        }
        throw new Error('values requires an object or array');
    },

    has: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('has requires an argument');
        const keys = evaluate(args[0], ctx);
        const key = keys[0];
        const val = ctx.input;

        if (Array.isArray(val)) {
            return [typeof key === 'number' && key >= 0 && key < val.length];
        }
        if (typeof val === 'object' && val !== null) {
            return [key in val];
        }
        return [false];
    },

    in: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('in requires an argument');
        const objs = evaluate(args[0], ctx);
        const obj = objs[0];
        const key = ctx.input;

        if (typeof obj === 'object' && obj !== null) {
            return [key in obj];
        }
        return [false];
    },

    to_entries: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
            throw new Error('to_entries requires an object');
        }
        return [Object.entries(val).map(([k, v]) => ({ key: k, value: v }))];
    },

    from_entries: (ctx) => {
        const val = ctx.input;
        if (!Array.isArray(val)) {
            throw new Error('from_entries requires an array');
        }
        const obj: Record<string, any> = {};
        for (const entry of val) {
            const key = entry.key ?? entry.k ?? entry.name ?? entry.Name;
            const value = entry.value ?? entry.v ?? entry.Value;
            if (key !== undefined) {
                obj[String(key)] = value;
            }
        }
        return [obj];
    },

    // =========================================================================
    // Array functions
    // =========================================================================

    first: (ctx) => {
        const val = ctx.input;
        if (Array.isArray(val)) {
            if (val.length === 0) throw new Error('first on empty array');
            return [val[0]];
        }
        return [val];
    },

    last: (ctx) => {
        const val = ctx.input;
        if (Array.isArray(val)) {
            if (val.length === 0) throw new Error('last on empty array');
            return [val[val.length - 1]];
        }
        return [val];
    },

    nth: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('nth requires an argument');
        const indices = evaluate(args[0], ctx);
        const n = indices[0];
        const val = ctx.input;

        if (Array.isArray(val)) {
            if (n < 0 || n >= val.length) throw new Error('index out of bounds');
            return [val[n]];
        }
        throw new Error('nth requires an array');
    },

    reverse: (ctx) => {
        const val = ctx.input;
        if (Array.isArray(val)) return [[...val].reverse()];
        if (typeof val === 'string') return [val.split('').reverse().join('')];
        throw new Error('reverse requires an array or string');
    },

    sort: (ctx) => {
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('sort requires an array');
        return [[...val].sort((a, b) => {
            if (typeof a === 'number' && typeof b === 'number') return a - b;
            return String(a).localeCompare(String(b));
        })];
    },

    sort_by: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('sort_by requires an argument');
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('sort_by requires an array');

        const withKeys = val.map(item => {
            const keys = evaluate(args[0], { ...ctx, input: item });
            return { item, key: keys[0] };
        });

        withKeys.sort((a, b) => {
            if (typeof a.key === 'number' && typeof b.key === 'number') return a.key - b.key;
            return String(a.key).localeCompare(String(b.key));
        });

        return [withKeys.map(x => x.item)];
    },

    unique: (ctx) => {
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('unique requires an array');
        const seen: any[] = [];
        const result: any[] = [];
        for (const item of val) {
            if (!seen.some(s => deepEqual(s, item))) {
                seen.push(item);
                result.push(item);
            }
        }
        return [result];
    },

    unique_by: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('unique_by requires an argument');
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('unique_by requires an array');

        const seen: any[] = [];
        const result: any[] = [];
        for (const item of val) {
            const keys = evaluate(args[0], { ...ctx, input: item });
            const key = keys[0];
            if (!seen.some(s => deepEqual(s, key))) {
                seen.push(key);
                result.push(item);
            }
        }
        return [result];
    },

    group_by: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('group_by requires an argument');
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('group_by requires an array');

        const groups = new Map<string, any[]>();
        for (const item of val) {
            const keys = evaluate(args[0], { ...ctx, input: item });
            const key = JSON.stringify(keys[0]);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(item);
        }

        return [Array.from(groups.values())];
    },

    flatten: (ctx, args, evaluate) => {
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('flatten requires an array');

        const depth = args.length > 0 ? evaluate(args[0], ctx)[0] : 1;

        function doFlatten(arr: any[], d: number): any[] {
            if (d <= 0) return arr;
            const result: any[] = [];
            for (const item of arr) {
                if (Array.isArray(item)) {
                    result.push(...doFlatten(item, d - 1));
                } else {
                    result.push(item);
                }
            }
            return result;
        }

        return [doFlatten(val, depth)];
    },

    add: (ctx) => {
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('add requires an array');
        if (val.length === 0) return [null];

        if (val.every(v => typeof v === 'number')) {
            return [val.reduce((a, b) => a + b, 0)];
        }
        if (val.every(v => typeof v === 'string')) {
            return [val.join('')];
        }
        if (val.every(v => Array.isArray(v))) {
            return [val.flat()];
        }
        if (val.every(v => typeof v === 'object' && v !== null && !Array.isArray(v))) {
            return [Object.assign({}, ...val)];
        }

        throw new Error('add requires array of compatible types');
    },

    min: (ctx) => {
        const val = ctx.input;
        if (!Array.isArray(val) || val.length === 0) throw new Error('min requires non-empty array');
        return [Math.min(...val.filter(v => typeof v === 'number'))];
    },

    max: (ctx) => {
        const val = ctx.input;
        if (!Array.isArray(val) || val.length === 0) throw new Error('max requires non-empty array');
        return [Math.max(...val.filter(v => typeof v === 'number'))];
    },

    min_by: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('min_by requires an argument');
        const val = ctx.input;
        if (!Array.isArray(val) || val.length === 0) throw new Error('min_by requires non-empty array');

        let minItem = val[0];
        let minKey = evaluate(args[0], { ...ctx, input: val[0] })[0];

        for (let i = 1; i < val.length; i++) {
            const key = evaluate(args[0], { ...ctx, input: val[i] })[0];
            if (key < minKey) {
                minKey = key;
                minItem = val[i];
            }
        }

        return [minItem];
    },

    max_by: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('max_by requires an argument');
        const val = ctx.input;
        if (!Array.isArray(val) || val.length === 0) throw new Error('max_by requires non-empty array');

        let maxItem = val[0];
        let maxKey = evaluate(args[0], { ...ctx, input: val[0] })[0];

        for (let i = 1; i < val.length; i++) {
            const key = evaluate(args[0], { ...ctx, input: val[i] })[0];
            if (key > maxKey) {
                maxKey = key;
                maxItem = val[i];
            }
        }

        return [maxItem];
    },

    contains: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('contains requires an argument');
        const needle = evaluate(args[0], ctx)[0];
        const val = ctx.input;

        if (Array.isArray(val)) {
            return [val.some(v => deepEqual(v, needle))];
        }
        if (typeof val === 'string' && typeof needle === 'string') {
            return [val.includes(needle)];
        }
        return [false];
    },

    inside: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('inside requires an argument');
        const haystack = evaluate(args[0], ctx)[0];
        const val = ctx.input;

        if (Array.isArray(haystack)) {
            return [haystack.some(v => deepEqual(v, val))];
        }
        if (typeof haystack === 'string' && typeof val === 'string') {
            return [haystack.includes(val)];
        }
        return [false];
    },

    index: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('index requires an argument');
        const needle = evaluate(args[0], ctx)[0];
        const val = ctx.input;

        if (Array.isArray(val)) {
            const idx = val.findIndex(v => deepEqual(v, needle));
            return [idx === -1 ? null : idx];
        }
        if (typeof val === 'string' && typeof needle === 'string') {
            const idx = val.indexOf(needle);
            return [idx === -1 ? null : idx];
        }
        return [null];
    },

    // =========================================================================
    // String functions
    // =========================================================================

    split: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('split requires an argument');
        const sep = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('split requires a string');
        return [val.split(sep)];
    },

    join: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('join requires an argument');
        const sep = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('join requires an array');
        return [val.join(sep)];
    },

    test: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('test requires an argument');
        const pattern = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('test requires a string');
        try {
            const regex = new RegExp(pattern);
            return [regex.test(val)];
        } catch {
            throw new Error(`invalid regex: ${pattern}`);
        }
    },

    match: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('match requires an argument');
        const pattern = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('match requires a string');
        try {
            const regex = new RegExp(pattern);
            const m = val.match(regex);
            if (!m) return [null];
            return [{
                offset: m.index,
                length: m[0].length,
                string: m[0],
                captures: m.slice(1).map((c, i) => ({
                    offset: m.index! + m[0].indexOf(c),
                    length: c?.length ?? 0,
                    string: c ?? '',
                    name: null
                }))
            }];
        } catch {
            throw new Error(`invalid regex: ${pattern}`);
        }
    },

    ltrimstr: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('ltrimstr requires an argument');
        const prefix = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') return [val];
        if (val.startsWith(prefix)) return [val.slice(prefix.length)];
        return [val];
    },

    rtrimstr: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('rtrimstr requires an argument');
        const suffix = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') return [val];
        if (val.endsWith(suffix)) return [val.slice(0, -suffix.length)];
        return [val];
    },

    startswith: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('startswith requires an argument');
        const prefix = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') return [false];
        return [val.startsWith(prefix)];
    },

    endswith: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('endswith requires an argument');
        const suffix = evaluate(args[0], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') return [false];
        return [val.endsWith(suffix)];
    },

    ascii_downcase: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('ascii_downcase requires a string');
        return [val.toLowerCase()];
    },

    ascii_upcase: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('ascii_upcase requires a string');
        return [val.toUpperCase()];
    },

    trim: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('trim requires a string');
        return [val.trim()];
    },

    gsub: (ctx, args, evaluate) => {
        if (args.length < 2) throw new Error('gsub requires pattern and replacement');
        const pattern = evaluate(args[0], ctx)[0];
        const replacement = evaluate(args[1], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('gsub requires a string');
        try {
            const regex = new RegExp(pattern, 'g');
            return [val.replace(regex, replacement)];
        } catch {
            throw new Error(`invalid regex: ${pattern}`);
        }
    },

    sub: (ctx, args, evaluate) => {
        if (args.length < 2) throw new Error('sub requires pattern and replacement');
        const pattern = evaluate(args[0], ctx)[0];
        const replacement = evaluate(args[1], ctx)[0];
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('sub requires a string');
        try {
            const regex = new RegExp(pattern);
            return [val.replace(regex, replacement)];
        } catch {
            throw new Error(`invalid regex: ${pattern}`);
        }
    },

    // =========================================================================
    // Conversion functions
    // =========================================================================

    tostring: (ctx) => {
        const val = ctx.input;
        if (typeof val === 'string') return [val];
        return [JSON.stringify(val)];
    },

    tonumber: (ctx) => {
        const val = ctx.input;
        if (typeof val === 'number') return [val];
        if (typeof val === 'string') {
            const n = parseFloat(val);
            if (isNaN(n)) throw new Error(`cannot convert to number: ${val}`);
            return [n];
        }
        throw new Error('tonumber requires a string or number');
    },

    tojson: (ctx) => [JSON.stringify(ctx.input)],

    fromjson: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'string') throw new Error('fromjson requires a string');
        return [JSON.parse(val)];
    },

    // =========================================================================
    // Math functions
    // =========================================================================

    floor: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'number') throw new Error('floor requires a number');
        return [Math.floor(val)];
    },

    ceil: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'number') throw new Error('ceil requires a number');
        return [Math.ceil(val)];
    },

    round: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'number') throw new Error('round requires a number');
        return [Math.round(val)];
    },

    sqrt: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'number') throw new Error('sqrt requires a number');
        return [Math.sqrt(val)];
    },

    fabs: (ctx) => {
        const val = ctx.input;
        if (typeof val !== 'number') throw new Error('fabs requires a number');
        return [Math.abs(val)];
    },

    // =========================================================================
    // Selection/filtering
    // =========================================================================

    select: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('select requires a condition');
        const results = evaluate(args[0], ctx);
        // If condition is truthy, output input; otherwise output nothing
        if (results.length > 0 && results[0]) {
            return [ctx.input];
        }
        return [];
    },

    empty: () => [],

    error: (ctx, args, evaluate) => {
        if (args.length > 0) {
            const msg = evaluate(args[0], ctx)[0];
            throw new Error(String(msg));
        }
        throw new Error('error');
    },

    // =========================================================================
    // Higher-order functions
    // =========================================================================

    map: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('map requires an argument');
        const val = ctx.input;
        if (!Array.isArray(val)) throw new Error('map requires an array');

        const results: any[] = [];
        for (const item of val) {
            const mapped = evaluate(args[0], { ...ctx, input: item });
            results.push(...mapped);
        }
        return [results];
    },

    map_values: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('map_values requires an argument');
        const val = ctx.input;

        if (Array.isArray(val)) {
            const results: any[] = [];
            for (const item of val) {
                const mapped = evaluate(args[0], { ...ctx, input: item });
                if (mapped.length > 0) results.push(mapped[0]);
            }
            return [results];
        }

        if (typeof val === 'object' && val !== null) {
            const result: Record<string, any> = {};
            for (const [k, v] of Object.entries(val)) {
                const mapped = evaluate(args[0], { ...ctx, input: v });
                if (mapped.length > 0) result[k] = mapped[0];
            }
            return [result];
        }

        throw new Error('map_values requires an array or object');
    },

    // =========================================================================
    // Path functions
    // =========================================================================

    getpath: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('getpath requires a path');
        const path = evaluate(args[0], ctx)[0];
        if (!Array.isArray(path)) throw new Error('path must be an array');

        let val = ctx.input;
        for (const segment of path) {
            if (val === null || val === undefined) return [null];
            val = val[segment];
        }
        return [val];
    },

    setpath: (ctx, args, evaluate) => {
        if (args.length < 2) throw new Error('setpath requires path and value');
        const path = evaluate(args[0], ctx)[0];
        const newVal = evaluate(args[1], ctx)[0];
        if (!Array.isArray(path)) throw new Error('path must be an array');

        const result = JSON.parse(JSON.stringify(ctx.input));
        let current = result;

        for (let i = 0; i < path.length - 1; i++) {
            const segment = path[i];
            if (current[segment] === undefined) {
                current[segment] = typeof path[i + 1] === 'number' ? [] : {};
            }
            current = current[segment];
        }

        if (path.length > 0) {
            current[path[path.length - 1]] = newVal;
        }

        return [result];
    },

    delpaths: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('delpaths requires paths');
        const paths = evaluate(args[0], ctx)[0];
        if (!Array.isArray(paths)) throw new Error('paths must be an array');

        let result = JSON.parse(JSON.stringify(ctx.input));

        // Sort paths by length descending to delete deepest first
        const sortedPaths = [...paths].sort((a, b) => b.length - a.length);

        for (const path of sortedPaths) {
            if (path.length === 0) continue;

            let current = result;
            for (let i = 0; i < path.length - 1; i++) {
                if (current === null || current === undefined) break;
                current = current[path[i]];
            }

            if (current !== null && current !== undefined) {
                const lastKey = path[path.length - 1];
                if (Array.isArray(current) && typeof lastKey === 'number') {
                    current.splice(lastKey, 1);
                } else {
                    delete current[lastKey];
                }
            }
        }

        return [result];
    },

    // =========================================================================
    // Misc
    // =========================================================================

    debug: (ctx) => {
        console.error('DEBUG:', JSON.stringify(ctx.input, null, 2));
        return [ctx.input];
    },

    env: (ctx) => {
        // Return empty object in this context (no process.env access)
        return [{}];
    },

    now: () => [Date.now() / 1000],

    range: (ctx, args, evaluate) => {
        if (args.length === 0) throw new Error('range requires arguments');

        let start = 0;
        let end: number;
        let step = 1;

        if (args.length === 1) {
            end = evaluate(args[0], ctx)[0];
        } else if (args.length === 2) {
            start = evaluate(args[0], ctx)[0];
            end = evaluate(args[1], ctx)[0];
        } else {
            start = evaluate(args[0], ctx)[0];
            end = evaluate(args[1], ctx)[0];
            step = evaluate(args[2], ctx)[0];
        }

        const results: number[] = [];
        if (step > 0) {
            for (let i = start; i < end; i += step) results.push(i);
        } else if (step < 0) {
            for (let i = start; i > end; i += step) results.push(i);
        }
        return results;
    },

    recurse: (ctx, args, evaluate) => {
        const results: any[] = [ctx.input];
        const seen = new Set<string>();

        function recurseInto(val: any): void {
            const key = JSON.stringify(val);
            if (seen.has(key)) return;
            seen.add(key);

            let children: any[];
            if (args.length > 0) {
                children = evaluate(args[0], { ...ctx, input: val });
            } else {
                // Default: recurse into arrays and object values
                if (Array.isArray(val)) {
                    children = val;
                } else if (typeof val === 'object' && val !== null) {
                    children = Object.values(val);
                } else {
                    return;
                }
            }

            for (const child of children) {
                if (child !== null && child !== undefined) {
                    results.push(child);
                    recurseInto(child);
                }
            }
        }

        recurseInto(ctx.input);
        return results;
    },
};
