/**
 * Utility Library for VFS Scripts
 *
 * Lodash-inspired utilities. Pure functions, no I/O.
 */

type PropertyPath = string | string[];
type PropertyKey = string | number | symbol;
type Iteratee<T> = keyof T | ((item: T) => unknown);

// ============================================================================
// Object Utilities
// ============================================================================

/**
 * Get a value at a path in an object, with optional default.
 *
 *     get(user, 'profile.name')
 *     get(user, 'profile.name', 'anonymous')
 *     get(user, ['profile', 'name'])
 */
export function get<T = unknown>(obj: unknown, path: PropertyPath, defaultValue?: T): T | undefined {
    const keys = typeof path === 'string' ? path.split('.') : path;
    let result: unknown = obj;

    for (const key of keys) {
        if (result == null) {
            return defaultValue;
        }
        result = (result as Record<string, unknown>)[key];
    }

    return (result === undefined ? defaultValue : result) as T | undefined;
}

/**
 * Set a value at a path in an object. Mutates the object.
 *
 *     set(user, 'profile.name', 'Alice')
 *     set(user, ['profile', 'settings', 'theme'], 'dark')
 */
export function set<T extends object>(obj: T, path: PropertyPath, value: unknown): T {
    const keys = typeof path === 'string' ? path.split('.') : path;
    let current: Record<string, unknown> = obj as Record<string, unknown>;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (current[key] == null || typeof current[key] !== 'object') {
            current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]] = value;
    return obj;
}

/**
 * Pick specified keys from an object.
 *
 *     pick(user, ['id', 'name'])
 */
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
    const result = {} as Pick<T, K>;
    for (const key of keys) {
        if (key in obj) {
            result[key] = obj[key];
        }
    }
    return result;
}

/**
 * Omit specified keys from an object.
 *
 *     omit(user, ['password', 'secret'])
 */
export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
    const result = { ...obj };
    for (const key of keys) {
        delete result[key];
    }
    return result as Omit<T, K>;
}

/**
 * Deep merge objects. Later sources override earlier ones.
 *
 *     merge({ a: 1 }, { b: 2 }, { a: 3 })  // { a: 3, b: 2 }
 */
export function merge<T extends object>(...sources: Partial<T>[]): T {
    const result: Record<PropertyKey, unknown> = {};

    for (const source of sources) {
        if (source == null) continue;

        for (const key of Object.keys(source)) {
            const srcVal = (source as Record<string, unknown>)[key];
            const dstVal = result[key];

            if (isPlainObject(srcVal) && isPlainObject(dstVal)) {
                result[key] = merge(dstVal as object, srcVal as object);
            } else {
                result[key] = srcVal;
            }
        }
    }

    return result as T;
}

/**
 * Deep clone an object.
 */
export function cloneDeep<T>(obj: T): T {
    return structuredClone(obj);
}

// ============================================================================
// Array Utilities
// ============================================================================

/**
 * Group array items by a key or function.
 *
 *     groupBy(users, 'role')
 *     groupBy(users, u => u.age > 18 ? 'adult' : 'minor')
 */
export function groupBy<T>(arr: T[], iteratee: Iteratee<T>): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    const fn = typeof iteratee === 'function' ? iteratee : (item: T) => item[iteratee];

    for (const item of arr) {
        const key = String(fn(item));
        if (!result[key]) {
            result[key] = [];
        }
        result[key].push(item);
    }

    return result;
}

/**
 * Index array items by a key.
 *
 *     keyBy(users, 'id')  // { '123': user1, '456': user2 }
 */
export function keyBy<T>(arr: T[], iteratee: Iteratee<T>): Record<string, T> {
    const result: Record<string, T> = {};
    const fn = typeof iteratee === 'function' ? iteratee : (item: T) => item[iteratee];

    for (const item of arr) {
        const key = String(fn(item));
        result[key] = item;
    }

    return result;
}

/**
 * Sort array by a key or function.
 *
 *     sortBy(users, 'name')
 *     sortBy(users, u => u.lastName)
 */
export function sortBy<T>(arr: T[], iteratee: Iteratee<T>): T[] {
    const fn = typeof iteratee === 'function' ? iteratee : (item: T) => item[iteratee];

    return [...arr].sort((a, b) => {
        const aVal = fn(a);
        const bVal = fn(b);

        if (aVal < bVal) return -1;
        if (aVal > bVal) return 1;
        return 0;
    });
}

/**
 * Get unique values from an array.
 *
 *     uniq([1, 2, 2, 3])  // [1, 2, 3]
 */
export function uniq<T>(arr: T[]): T[] {
    return [...new Set(arr)];
}

/**
 * Get unique values by a key or function.
 *
 *     uniqBy(users, 'email')
 */
export function uniqBy<T>(arr: T[], iteratee: Iteratee<T>): T[] {
    const fn = typeof iteratee === 'function' ? iteratee : (item: T) => item[iteratee];
    const seen = new Set<unknown>();
    const result: T[] = [];

    for (const item of arr) {
        const key = fn(item);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    }

    return result;
}

/**
 * Split array into chunks of specified size.
 *
 *     chunk([1, 2, 3, 4, 5], 2)  // [[1, 2], [3, 4], [5]]
 */
export function chunk<T>(arr: T[], size: number): T[][] {
    if (size < 1) return [];

    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }
    return result;
}

/**
 * Flatten array one level deep.
 *
 *     flatten([[1, 2], [3, 4]])  // [1, 2, 3, 4]
 */
export function flatten<T>(arr: T[][]): T[] {
    return arr.flat();
}

/**
 * Remove falsy values from array.
 *
 *     compact([0, 1, false, 2, '', 3])  // [1, 2, 3]
 */
export function compact<T>(arr: (T | null | undefined | false | '' | 0)[]): T[] {
    return arr.filter(Boolean) as T[];
}

/**
 * Get first n elements.
 */
export function take<T>(arr: T[], n: number = 1): T[] {
    return arr.slice(0, n);
}

/**
 * Get last n elements.
 */
export function takeRight<T>(arr: T[], n: number = 1): T[] {
    return arr.slice(-n);
}

/**
 * Get first element.
 */
export function first<T>(arr: T[]): T | undefined {
    return arr[0];
}

/**
 * Get last element.
 */
export function last<T>(arr: T[]): T | undefined {
    return arr[arr.length - 1];
}

// ============================================================================
// Function Utilities
// ============================================================================

/**
 * Debounce a function.
 *
 *     const save = debounce(() => saveData(), 300)
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
    fn: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    return (...args: Parameters<T>) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            fn(...args);
            timeoutId = null;
        }, wait);
    };
}

/**
 * Throttle a function.
 *
 *     const update = throttle(() => updateUI(), 100)
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
    fn: T,
    wait: number
): (...args: Parameters<T>) => void {
    let lastCall = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    return (...args: Parameters<T>) => {
        const now = Date.now();
        const remaining = wait - (now - lastCall);

        if (remaining <= 0) {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            lastCall = now;
            fn(...args);
        } else if (!timeoutId) {
            timeoutId = setTimeout(() => {
                lastCall = Date.now();
                timeoutId = null;
                fn(...args);
            }, remaining);
        }
    };
}

/**
 * Memoize a function.
 *
 *     const expensive = memoize((n) => computeFib(n))
 */
export function memoize<T extends (...args: unknown[]) => unknown>(
    fn: T,
    keyFn?: (...args: Parameters<T>) => string
): T {
    const cache = new Map<string, ReturnType<T>>();

    return ((...args: Parameters<T>) => {
        const key = keyFn ? keyFn(...args) : JSON.stringify(args);

        if (cache.has(key)) {
            return cache.get(key);
        }

        const result = fn(...args) as ReturnType<T>;
        cache.set(key, result);
        return result;
    }) as T;
}

// ============================================================================
// Type Checks
// ============================================================================

/**
 * Check if value is a plain object (not array, null, etc).
 */
export function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
}

/**
 * Check if value is empty (null, undefined, empty string/array/object).
 */
export function isEmpty(value: unknown): boolean {
    if (value == null) return true;
    if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
    if (value instanceof Map || value instanceof Set) return value.size === 0;
    if (isPlainObject(value)) return Object.keys(value).length === 0;
    return false;
}

/**
 * Check if value is nil (null or undefined).
 */
export function isNil(value: unknown): value is null | undefined {
    return value == null;
}
