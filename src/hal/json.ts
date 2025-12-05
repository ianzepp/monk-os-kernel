/**
 * JSON Device - JSON encoding/decoding
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The JSON Device provides JSON encoding and decoding through the HAL boundary.
 * While JSON.parse/stringify are standard JavaScript APIs, wrapping them in a
 * HAL device maintains the abstraction that "Bun is the hardware" and allows
 * for testability via interface swapping.
 *
 * OPERATIONS
 * ==========
 * - decode(text): Parse JSON string into JavaScript value
 * - encode(data, pretty?): Serialize JavaScript value to JSON string
 *
 * INVARIANTS
 * ==========
 * INV-1: decode() throws on invalid JSON (SyntaxError wrapped in EIO)
 * INV-2: encode() throws on non-serializable values (circular refs, BigInt, etc.)
 * INV-3: decode(encode(x)) === x for JSON-safe values (round-trip)
 * INV-4: Operations are synchronous and stateless
 *
 * CONCURRENCY MODEL
 * =================
 * All operations are synchronous and stateless. No shared mutable state.
 * Safe for concurrent use from multiple processes.
 *
 * @module hal/json
 */

import { EIO } from './errors.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * JSON device interface.
 *
 * WHY: Provides HAL abstraction for JSON operations. Enables testability
 * and maintains the "Bun is hardware" boundary consistently.
 */
export interface JsonDevice {
    /**
     * Decode JSON string to JavaScript value.
     *
     * @param text - JSON string to parse
     * @returns Parsed JavaScript value
     * @throws EIO on invalid JSON syntax
     */
    decode(text: string): unknown;

    /**
     * Encode JavaScript value to JSON string.
     *
     * @param data - Value to serialize
     * @param pretty - If true, format with 2-space indentation
     * @returns JSON string
     * @throws EIO on non-serializable values
     */
    encode(data: unknown, pretty?: boolean): string;
}

// =============================================================================
// MAIN IMPLEMENTATION
// =============================================================================

/**
 * Bun JSON device implementation.
 *
 * Uses standard JSON.parse/stringify APIs.
 *
 * Bun touchpoints:
 * - JSON.parse() - Parse JSON string
 * - JSON.stringify() - Serialize to JSON string
 *
 * WHY wrap standard APIs: Maintains HAL abstraction, enables mock injection
 * for testing, and provides consistent error handling across all HAL devices.
 */
export class BunJsonDevice implements JsonDevice {
    /**
     * Decode JSON string to JavaScript value.
     *
     * @param text - JSON string to parse
     * @returns Parsed JavaScript value
     * @throws EIO on invalid JSON syntax
     */
    decode(text: string): unknown {
        try {
            return JSON.parse(text);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new EIO(`JSON decode failed: ${message}`);
        }
    }

    /**
     * Encode JavaScript value to JSON string.
     *
     * @param data - Value to serialize
     * @param pretty - If true, format with 2-space indentation
     * @returns JSON string
     * @throws EIO on non-serializable values
     */
    encode(data: unknown, pretty?: boolean): string {
        try {
            return JSON.stringify(data, null, pretty ? 2 : undefined);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new EIO(`JSON encode failed: ${message}`);
        }
    }
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Mock JSON device for testing.
 *
 * Allows injecting custom encode/decode behavior or tracking calls.
 *
 * WHY: Tests may want to:
 * - Verify specific JSON is being encoded/decoded
 * - Simulate parse errors
 * - Track call counts and arguments
 */
export class MockJsonDevice implements JsonDevice {
    /** Track decode calls for assertions */
    readonly decodeCalls: string[] = [];

    /** Track encode calls for assertions */
    readonly encodeCalls: unknown[] = [];

    /** Optional custom decode implementation */
    private _decode?: (text: string) => unknown;

    /** Optional custom encode implementation */
    private _encode?: (data: unknown, pretty?: boolean) => string;

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
    onEncode(fn: (data: unknown, pretty?: boolean) => string): this {
        this._encode = fn;
        return this;
    }

    decode(text: string): unknown {
        this.decodeCalls.push(text);
        if (this._decode) {
            return this._decode(text);
        }
        return JSON.parse(text);
    }

    encode(data: unknown, pretty?: boolean): string {
        this.encodeCalls.push(data);
        if (this._encode) {
            return this._encode(data, pretty);
        }
        return JSON.stringify(data, null, pretty ? 2 : undefined);
    }

    /**
     * Reset call tracking.
     */
    reset(): void {
        this.decodeCalls.length = 0;
        this.encodeCalls.length = 0;
    }
}
