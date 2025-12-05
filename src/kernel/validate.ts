/**
 * Type Validation Utilities
 *
 * Fail-fast validation for untrusted data at kernel boundaries.
 * All functions throw EINVAL with descriptive messages on failure.
 *
 * Philosophy: Validate once at the boundary, trust internally.
 */

import { EINVAL, EBADF } from '@src/hal/errors.js';

// ============================================================================
// Primitive Validators
// ============================================================================

/**
 * Assert value is a string.
 */
export function assertString(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string') {
        throw new EINVAL(`${name} must be a string, got ${typeof value}`);
    }
}

/**
 * Assert value is a non-empty string.
 */
export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
    assertString(value, name);
    if (value.length === 0) {
        throw new EINVAL(`${name} must be non-empty`);
    }
}

/**
 * Assert value is a number.
 */
export function assertNumber(value: unknown, name: string): asserts value is number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new EINVAL(`${name} must be a number, got ${typeof value}`);
    }
}

/**
 * Assert value is a non-negative integer (valid fd, port, etc).
 */
export function assertNonNegativeInt(value: unknown, name: string): asserts value is number {
    assertNumber(value, name);
    if (!Number.isInteger(value) || value < 0) {
        throw new EINVAL(`${name} must be a non-negative integer, got ${value}`);
    }
}

/**
 * Assert value is a positive integer.
 */
export function assertPositiveInt(value: unknown, name: string): asserts value is number {
    assertNumber(value, name);
    if (!Number.isInteger(value) || value <= 0) {
        throw new EINVAL(`${name} must be a positive integer, got ${value}`);
    }
}

/**
 * Assert value is a boolean.
 */
export function assertBoolean(value: unknown, name: string): asserts value is boolean {
    if (typeof value !== 'boolean') {
        throw new EINVAL(`${name} must be a boolean, got ${typeof value}`);
    }
}

/**
 * Assert value is a Uint8Array.
 */
export function assertUint8Array(value: unknown, name: string): asserts value is Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw new EINVAL(`${name} must be Uint8Array, got ${value?.constructor?.name ?? typeof value}`);
    }
}

/**
 * Assert value is an object (not null, not array).
 */
export function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new EINVAL(`${name} must be an object, got ${value === null ? 'null' : typeof value}`);
    }
}

/**
 * Assert value is an array.
 */
export function assertArray(value: unknown, name: string): asserts value is unknown[] {
    if (!Array.isArray(value)) {
        throw new EINVAL(`${name} must be an array, got ${typeof value}`);
    }
}

// ============================================================================
// Optional Validators (return typed value or undefined)
// ============================================================================

/**
 * Parse optional string, return undefined if missing/undefined.
 */
export function optionalString(value: unknown, name: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    assertString(value, name);

    return value;
}

/**
 * Parse optional non-negative integer, return undefined if missing.
 */
export function optionalNonNegativeInt(value: unknown, name: string): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    assertNonNegativeInt(value, name);

    return value;
}

/**
 * Parse optional positive integer, return undefined if missing.
 */
export function optionalPositiveInt(value: unknown, name: string): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    assertPositiveInt(value, name);

    return value;
}

/**
 * Parse optional boolean, return undefined if missing.
 */
export function optionalBoolean(value: unknown, name: string): boolean | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    assertBoolean(value, name);

    return value;
}

// ============================================================================
// Compound Validators
// ============================================================================

/**
 * Validated open flags structure.
 */
export interface ValidatedOpenFlags {
    read: boolean;
    write: boolean;
    create: boolean;
    truncate: boolean;
    append: boolean;
}

/**
 * Validate and normalize open flags.
 * Accepts undefined (defaults to read-only) or object with boolean flags.
 */
export function validateOpenFlags(value: unknown): ValidatedOpenFlags {
    if (value === undefined || value === null) {
        return { read: true, write: false, create: false, truncate: false, append: false };
    }

    assertObject(value, 'flags');

    return {
        read: optionalBoolean(value['read'], 'flags.read') ?? false,
        write: optionalBoolean(value['write'], 'flags.write') ?? false,
        create: optionalBoolean(value['create'], 'flags.create') ?? false,
        truncate: optionalBoolean(value['truncate'], 'flags.truncate') ?? false,
        append: optionalBoolean(value['append'], 'flags.append') ?? false,
    };
}

/**
 * Validate seek whence value.
 */
export type SeekWhence = 'start' | 'current' | 'end';

export function validateSeekWhence(value: unknown): SeekWhence {
    if (value === undefined || value === null) {
        return 'start';
    }

    assertString(value, 'whence');
    if (value !== 'start' && value !== 'current' && value !== 'end') {
        throw new EINVAL(`whence must be 'start', 'current', or 'end', got '${value}'`);
    }

    return value;
}

// ============================================================================
// Message Data Validators
// ============================================================================

/**
 * Extract and validate message data as Record.
 * Returns empty record if data is undefined/null.
 */
export function getMessageData(msg: { data?: unknown }): Record<string, unknown> {
    if (msg.data === undefined || msg.data === null) {
        return {};
    }

    assertObject(msg.data, 'msg.data');

    return msg.data;
}

/**
 * Extract typed field from message data with validation.
 */
export function getDataString(data: Record<string, unknown>, key: string): string {
    const value = data[key];

    assertString(value, `data.${key}`);

    return value;
}

export function getDataNumber(data: Record<string, unknown>, key: string): number {
    const value = data[key];

    assertNumber(value, `data.${key}`);

    return value;
}

export function getDataUint8Array(data: Record<string, unknown>, key: string): Uint8Array {
    const value = data[key];

    assertUint8Array(value, `data.${key}`);

    return value;
}

export function getOptionalDataString(data: Record<string, unknown>, key: string): string | undefined {
    return optionalString(data[key], `data.${key}`);
}

export function getOptionalDataNumber(data: Record<string, unknown>, key: string): number | undefined {
    const value = data[key];

    if (value === undefined || value === null) {
        return undefined;
    }

    assertNumber(value, `data.${key}`);

    return value;
}

export function getOptionalDataPositiveInt(data: Record<string, unknown>, key: string): number | undefined {
    return optionalPositiveInt(data[key], `data.${key}`);
}

// ============================================================================
// Resource Validators
// ============================================================================

/**
 * Assert a resource exists and is not closed.
 */
export function assertResourceOpen<T extends { closed: boolean }>(
    resource: T | undefined,
    fd: number,
): asserts resource is T {
    if (!resource) {
        throw new EBADF(`Bad file descriptor: ${fd}`);
    }

    if (resource.closed) {
        throw new EBADF(`File descriptor closed: ${fd}`);
    }
}

/**
 * Assert a value from array/map access is defined.
 * Use when noUncheckedIndexedAccess returns T | undefined.
 */
export function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
    if (value === undefined) {
        throw new EINVAL(message);
    }
}

/**
 * Unwrap a value from array/map access, throwing if undefined.
 */
export function unwrap<T>(value: T | undefined, message: string): T {
    if (value === undefined) {
        throw new EINVAL(message);
    }

    return value;
}

/**
 * Unwrap with default - return default if undefined.
 */
export function unwrapOr<T>(value: T | undefined, defaultValue: T): T {
    return value !== undefined ? value : defaultValue;
}
