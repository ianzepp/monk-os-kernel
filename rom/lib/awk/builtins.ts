/**
 * AWK Built-in Functions
 *
 * Implements standard AWK functions for string manipulation,
 * math operations, and I/O.
 */

import type { AwkValue, AwkArray, RuntimeState } from './types.js';

export type BuiltinFn = (
    args: AwkValue[],
    state: RuntimeState,
    setVar?: (name: string, value: AwkValue) => void,
    setArray?: (name: string, key: string, value: AwkValue) => void
) => AwkValue;

// Coercion helpers
export function toNumber(v: AwkValue): number {
    if (typeof v === 'number') return v;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
}

export function toString(v: AwkValue): string {
    if (typeof v === 'string') return v;
    if (Number.isInteger(v)) return String(v);
    return v.toString();
}

export function toBool(v: AwkValue): boolean {
    if (typeof v === 'number') return v !== 0;
    return v !== '';
}

// Random number generator state
let randSeed = Date.now();

function lcg(): number {
    // Linear congruential generator
    randSeed = (randSeed * 1103515245 + 12345) & 0x7fffffff;
    return randSeed / 0x7fffffff;
}

// String functions
const length: BuiltinFn = (args, state) => {
    if (args.length === 0) {
        // length() returns length of $0
        return state.fields[0]?.length ?? 0;
    }
    return toString(args[0]).length;
};

const substr: BuiltinFn = (args) => {
    const str = toString(args[0]);
    const start = Math.max(1, toNumber(args[1])) - 1; // AWK is 1-indexed
    const len = args.length > 2 ? toNumber(args[2]) : str.length - start;
    return str.substring(start, start + len);
};

const index: BuiltinFn = (args) => {
    const str = toString(args[0]);
    const needle = toString(args[1]);
    const pos = str.indexOf(needle);
    return pos === -1 ? 0 : pos + 1; // AWK is 1-indexed, 0 means not found
};

const split: BuiltinFn = (args, state, setVar, setArray) => {
    const str = toString(args[0]);
    const arrayName = toString(args[1]);
    const fs = args.length > 2 ? toString(args[2]) : state.builtins.FS;

    // Clear existing array
    if (setArray) {
        const existing = state.globals.arrays.get(arrayName);
        if (existing) existing.clear();
    }

    let parts: string[];
    if (fs === ' ') {
        // Special case: split on whitespace runs
        parts = str.trim().split(/\s+/);
    } else if (fs === '') {
        // Split into characters
        parts = str.split('');
    } else {
        try {
            parts = str.split(new RegExp(fs));
        } catch {
            parts = str.split(fs);
        }
    }

    // Populate array (1-indexed)
    if (setArray) {
        for (let i = 0; i < parts.length; i++) {
            setArray(arrayName, String(i + 1), parts[i]);
        }
    }

    return parts.length;
};

const sub: BuiltinFn = (args, state, setVar) => {
    const pattern = toString(args[0]);
    const replacement = toString(args[1]);
    const target = args.length > 2 ? toString(args[2]) : state.fields[0];

    let regex: RegExp;
    try {
        regex = new RegExp(pattern);
    } catch {
        return 0;
    }

    if (!regex.test(target)) return 0;

    const result = target.replace(regex, replacement.replace(/&/g, '$&'));

    // Update target (default is $0)
    if (args.length > 2 && setVar) {
        // This is tricky - args[2] should be an lvalue
        // For now, we assume it's updating $0 if not specified
    } else {
        state.fields[0] = result;
    }

    return 1;
};

const gsub: BuiltinFn = (args, state, setVar) => {
    const pattern = toString(args[0]);
    const replacement = toString(args[1]);
    const target = args.length > 2 ? toString(args[2]) : state.fields[0];

    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'g');
    } catch {
        return 0;
    }

    const matches = target.match(regex);
    if (!matches) return 0;

    const result = target.replace(regex, replacement.replace(/&/g, '$&'));

    // Update target
    if (args.length <= 2) {
        state.fields[0] = result;
    }

    return matches.length;
};

const match: BuiltinFn = (args, state) => {
    const str = toString(args[0]);
    const pattern = toString(args[1]);

    let regex: RegExp;
    try {
        regex = new RegExp(pattern);
    } catch {
        state.builtins.RSTART = 0;
        state.builtins.RLENGTH = -1;
        return 0;
    }

    const result = regex.exec(str);
    if (!result) {
        state.builtins.RSTART = 0;
        state.builtins.RLENGTH = -1;
        return 0;
    }

    state.builtins.RSTART = result.index + 1;
    state.builtins.RLENGTH = result[0].length;
    return state.builtins.RSTART;
};

const tolower: BuiltinFn = (args) => {
    return toString(args[0]).toLowerCase();
};

const toupper: BuiltinFn = (args) => {
    return toString(args[0]).toUpperCase();
};

const sprintf: BuiltinFn = (args) => {
    if (args.length === 0) return '';
    return formatPrintf(toString(args[0]), args.slice(1));
};

// Math functions
const sin: BuiltinFn = (args) => Math.sin(toNumber(args[0]));
const cos: BuiltinFn = (args) => Math.cos(toNumber(args[0]));
const atan2: BuiltinFn = (args) => Math.atan2(toNumber(args[0]), toNumber(args[1]));
const exp: BuiltinFn = (args) => Math.exp(toNumber(args[0]));
const log: BuiltinFn = (args) => Math.log(toNumber(args[0]));
const sqrt: BuiltinFn = (args) => Math.sqrt(toNumber(args[0]));
const int: BuiltinFn = (args) => Math.trunc(toNumber(args[0]));

const rand: BuiltinFn = () => lcg();

const srand: BuiltinFn = (args) => {
    const oldSeed = randSeed;
    randSeed = args.length > 0 ? toNumber(args[0]) : Date.now();
    return oldSeed;
};

// System functions
const system: BuiltinFn = () => {
    // Not implemented in virtual environment
    return -1;
};

const getline_builtin: BuiltinFn = () => {
    // Handled specially in interpreter
    return 0;
};

// Printf formatting helper
export function formatPrintf(format: string, args: AwkValue[]): string {
    let result = '';
    let argIdx = 0;
    let i = 0;

    while (i < format.length) {
        if (format[i] !== '%') {
            result += format[i++];
            continue;
        }

        i++; // skip %
        if (i >= format.length) {
            result += '%';
            break;
        }

        // %% escape
        if (format[i] === '%') {
            result += '%';
            i++;
            continue;
        }

        // Parse format spec: %[flags][width][.precision]specifier
        let flags = '';
        let width = '';
        let precision = '';

        // Flags: -, +, space, #, 0
        while ('-+ #0'.includes(format[i])) {
            flags += format[i++];
        }

        // Width
        while (format[i] >= '0' && format[i] <= '9') {
            width += format[i++];
        }

        // Precision
        if (format[i] === '.') {
            i++;
            while (format[i] >= '0' && format[i] <= '9') {
                precision += format[i++];
            }
        }

        // Specifier
        const spec = format[i++];
        const arg = argIdx < args.length ? args[argIdx++] : '';

        result += formatValue(arg, spec, flags, width, precision);
    }

    return result;
}

function formatValue(
    arg: AwkValue,
    spec: string,
    flags: string,
    width: string,
    precision: string
): string {
    const widthNum = width ? parseInt(width, 10) : 0;
    const precNum = precision ? parseInt(precision, 10) : -1;
    const leftAlign = flags.includes('-');
    const padZero = flags.includes('0') && !leftAlign;
    const showSign = flags.includes('+');
    const spaceSign = flags.includes(' ');

    let result: string;

    switch (spec) {
        case 'd':
        case 'i': {
            const n = Math.trunc(toNumber(arg));
            result = Math.abs(n).toString();
            if (n < 0) result = '-' + result;
            else if (showSign) result = '+' + result;
            else if (spaceSign) result = ' ' + result;
            break;
        }

        case 'o': {
            const n = Math.trunc(toNumber(arg));
            result = Math.abs(n).toString(8);
            if (flags.includes('#') && n !== 0) result = '0' + result;
            break;
        }

        case 'x': {
            const n = Math.trunc(toNumber(arg));
            result = Math.abs(n).toString(16);
            if (flags.includes('#') && n !== 0) result = '0x' + result;
            break;
        }

        case 'X': {
            const n = Math.trunc(toNumber(arg));
            result = Math.abs(n).toString(16).toUpperCase();
            if (flags.includes('#') && n !== 0) result = '0X' + result;
            break;
        }

        case 'e': {
            const n = toNumber(arg);
            const prec = precNum >= 0 ? precNum : 6;
            result = n.toExponential(prec);
            break;
        }

        case 'E': {
            const n = toNumber(arg);
            const prec = precNum >= 0 ? precNum : 6;
            result = n.toExponential(prec).toUpperCase();
            break;
        }

        case 'f': {
            const n = toNumber(arg);
            const prec = precNum >= 0 ? precNum : 6;
            result = n.toFixed(prec);
            if (n >= 0 && showSign) result = '+' + result;
            else if (n >= 0 && spaceSign) result = ' ' + result;
            break;
        }

        case 'g': {
            const n = toNumber(arg);
            const prec = precNum >= 0 ? precNum : 6;
            result = n.toPrecision(prec);
            break;
        }

        case 'G': {
            const n = toNumber(arg);
            const prec = precNum >= 0 ? precNum : 6;
            result = n.toPrecision(prec).toUpperCase();
            break;
        }

        case 's': {
            result = toString(arg);
            if (precNum >= 0 && result.length > precNum) {
                result = result.substring(0, precNum);
            }
            break;
        }

        case 'c': {
            const s = toString(arg);
            result = s.length > 0 ? s[0] : '';
            break;
        }

        default:
            result = toString(arg);
    }

    // Pad to width
    if (widthNum > result.length) {
        const padChar = padZero ? '0' : ' ';
        const padding = padChar.repeat(widthNum - result.length);
        result = leftAlign ? result + padding : padding + result;
    }

    return result;
}

// Export all builtins
export const builtins: Record<string, BuiltinFn> = {
    // String functions
    length,
    substr,
    index,
    split,
    sub,
    gsub,
    match,
    tolower,
    toupper,
    sprintf,

    // Math functions
    sin,
    cos,
    atan2,
    exp,
    log,
    sqrt,
    int,
    rand,
    srand,

    // System
    system,
    getline: getline_builtin,
};
