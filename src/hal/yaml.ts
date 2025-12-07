/**
 * YAML Device - YAML encoding/decoding
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The YAML Device provides YAML encoding and decoding through the HAL boundary.
 * Bun has first-class YAML support via Bun.YAML.parse(), making YAML a native
 * data format alongside JSON and TOML.
 *
 * Primary use case: Loading package model definitions (YAML files)
 *
 * OPERATIONS
 * ==========
 * - decode(text): Parse YAML string into JavaScript value
 * - encode(data): Serialize JavaScript value to YAML string
 *
 * INVARIANTS
 * ==========
 * INV-1: decode() throws on invalid YAML syntax
 * INV-2: encode() produces valid YAML that can be decoded
 * INV-3: Operations are synchronous and stateless
 *
 * CONCURRENCY MODEL
 * =================
 * All operations are synchronous and stateless. No shared mutable state.
 * Safe for concurrent use from multiple processes.
 *
 * @module hal/yaml
 */

import { EIO, EINVAL } from './errors.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * YAML device interface.
 *
 * WHY: Provides HAL abstraction for YAML operations. Bun is the hardware,
 * so YAML parsing goes through HAL to maintain the abstraction boundary.
 */
export interface YamlDevice {
    /**
     * Decode YAML string to JavaScript value.
     *
     * @param text - YAML string to parse
     * @returns Parsed JavaScript value
     * @throws EIO on invalid YAML syntax
     */
    decode(text: string): unknown;

    /**
     * Encode JavaScript value to YAML string.
     *
     * @param data - Value to serialize
     * @returns YAML string
     * @throws ENOSYS if not implemented
     * @throws EIO on non-serializable values
     */
    encode(data: unknown): string;
}

// =============================================================================
// MAIN IMPLEMENTATION
// =============================================================================

/**
 * Bun YAML device implementation.
 *
 * Uses Bun's native YAML support via Bun.YAML.parse().
 *
 * Bun touchpoints:
 * - Bun.YAML.parse() - Parse YAML string (native, no dependencies)
 *
 * NOTE: Bun's YAML support is primarily for parsing. For encoding,
 * we implement a basic YAML serializer. For complex YAML output needs,
 * consider using a dedicated library.
 */
export class BunYamlDevice implements YamlDevice {
    /**
     * Decode YAML string to JavaScript value.
     *
     * Uses Bun's native YAML parser which supports full YAML 1.2 spec.
     *
     * @param text - YAML string to parse
     * @returns Parsed JavaScript value
     * @throws EIO on invalid YAML syntax
     */
    decode(text: string): unknown {
        try {
            // Bun.YAML.parse is Bun's native YAML parser
            return Bun.YAML.parse(text);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            throw new EIO(`YAML decode failed: ${message}`);
        }
    }

    /**
     * Encode JavaScript value to YAML string.
     *
     * Implements a basic YAML serializer for common use cases.
     * Handles: primitives, arrays, objects, null, undefined.
     *
     * @param data - Value to serialize
     * @returns YAML string
     * @throws EIO on non-serializable values
     */
    encode(data: unknown): string {
        try {
            return serializeYaml(data, 0);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            throw new EIO(`YAML encode failed: ${message}`);
        }
    }
}

// =============================================================================
// YAML SERIALIZER
// =============================================================================

/**
 * Serialize a JavaScript value to YAML string.
 *
 * WHY custom serializer: Bun's YAML support is focused on parsing.
 * This basic serializer handles common cases for model definitions.
 * For complex YAML output, consider using js-yaml or similar.
 *
 * @param data - Value to serialize
 * @param indent - Current indentation level
 * @returns YAML string
 */
function serializeYaml(data: unknown, indent: number): string {
    const prefix = '  '.repeat(indent);

    // Handle null/undefined
    if (data === null || data === undefined) {
        return 'null';
    }

    // Handle primitives
    if (typeof data === 'boolean') {
        return data ? 'true' : 'false';
    }

    if (typeof data === 'number') {
        if (Number.isNaN(data)) {
            return '.nan';
        }

        if (data === Infinity) {
            return '.inf';
        }

        if (data === -Infinity) {
            return '-.inf';
        }

        return String(data);
    }

    if (typeof data === 'string') {
        return serializeYamlString(data);
    }

    // Handle arrays
    if (Array.isArray(data)) {
        if (data.length === 0) {
            return '[]';
        }

        const lines: string[] = [];

        for (const item of data) {
            const value = serializeYaml(item, indent + 1);

            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                // Object items: put first key on same line as dash
                const firstNewline = value.indexOf('\n');

                if (firstNewline === -1) {
                    lines.push(`${prefix}- ${value}`);
                }
                else {
                    lines.push(`${prefix}- ${value}`);
                }
            }
            else {
                lines.push(`${prefix}- ${value}`);
            }
        }

        return '\n' + lines.join('\n');
    }

    // Handle objects
    if (typeof data === 'object') {
        const entries = Object.entries(data as Record<string, unknown>);

        if (entries.length === 0) {
            return '{}';
        }

        const lines: string[] = [];

        for (const [key, value] of entries) {
            const serializedKey = serializeYamlKey(key);
            const serializedValue = serializeYaml(value, indent + 1);

            if (typeof value === 'object' && value !== null) {
                // Complex value: put on next line with indent
                lines.push(`${prefix}${serializedKey}:${serializedValue}`);
            }
            else {
                // Simple value: put on same line
                lines.push(`${prefix}${serializedKey}: ${serializedValue}`);
            }
        }

        return (indent === 0 ? '' : '\n') + lines.join('\n');
    }

    // Handle other types
    throw new EINVAL(`Cannot serialize type: ${typeof data}`);
}

/**
 * Serialize a YAML key (object property name).
 *
 * Keys that contain special characters need quoting.
 */
function serializeYamlKey(key: string): string {
    // Quote keys with special characters
    if (/[:\-#[\]{}|>&*!?,'"@`]/.test(key) || /^\s|\s$/.test(key) || key === '') {
        return `"${escapeYamlString(key)}"`;
    }

    return key;
}

/**
 * Serialize a YAML string value.
 *
 * Handles quoting and escaping for strings that need it.
 */
function serializeYamlString(str: string): string {
    // Empty string
    if (str === '') {
        return '""';
    }

    // Check if quoting is needed
    const needsQuotes =
        // Starts/ends with whitespace
        /^\s|\s$/.test(str) ||
        // Contains special characters
        /[:\-#[\]{}|>&*!?,'"@`\n\r\t]/.test(str) ||
        // Looks like a number, boolean, or null
        /^(true|false|null|~|\d+\.?\d*|\.nan|\.inf|-\.inf)$/i.test(str) ||
        // Starts with special indicator
        /^[?:\-|>!&*]/.test(str);

    if (!needsQuotes) {
        return str;
    }

    // Use double quotes with escaping
    return `"${escapeYamlString(str)}"`;
}

/**
 * Escape special characters in a YAML double-quoted string.
 */
function escapeYamlString(str: string): string {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Mock YAML device for testing.
 *
 * Allows injecting custom encode/decode behavior or tracking calls.
 */
export class MockYamlDevice implements YamlDevice {
    /** Track decode calls for assertions */
    readonly decodeCalls: string[] = [];

    /** Track encode calls for assertions */
    readonly encodeCalls: unknown[] = [];

    /** Optional custom decode implementation */
    private _decode?: (text: string) => unknown;

    /** Optional custom encode implementation */
    private _encode?: (data: unknown) => string;

    /**
     * Set custom decode behavior.
     */
    onDecode(fn: (text: string) => unknown): this {
        this._decode = fn;

        return this;
    }

    /**
     * Set custom encode behavior.
     */
    onEncode(fn: (data: unknown) => string): this {
        this._encode = fn;

        return this;
    }

    decode(text: string): unknown {
        this.decodeCalls.push(text);
        if (this._decode) {
            return this._decode(text);
        }

        // For testing, use JSON.parse as a fallback
        // Real tests should set onDecode for proper YAML behavior
        try {
            return JSON.parse(text);
        }
        catch {
            throw new EIO('Mock YAML decode failed - set onDecode for real YAML parsing');
        }
    }

    encode(data: unknown): string {
        this.encodeCalls.push(data);
        if (this._encode) {
            return this._encode(data);
        }

        // For testing, use JSON as a fallback
        return JSON.stringify(data, null, 2);
    }

    /**
     * Reset call tracking.
     */
    reset(): void {
        this.decodeCalls.length = 0;
        this.encodeCalls.length = 0;
    }
}
