/**
 * Stream Types - Interfaces for stream flow control
 *
 * @module syscall/stream/types
 */

// =============================================================================
// DEPENDENCIES
// =============================================================================

/**
 * Injectable dependencies for StreamController.
 *
 * TESTABILITY: Inject mock implementations to control time in tests.
 * Real implementation uses Date.now() and global setTimeout.
 */
export interface StreamControllerDeps {
    /**
     * Get current time in milliseconds.
     * Default: Date.now
     */
    now: () => number;

    /**
     * Schedule a callback after delay.
     * Default: globalThis.setTimeout
     */
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;

    /**
     * Cancel a scheduled callback.
     * Default: globalThis.clearTimeout
     */
    clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => void;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configuration options for StreamController.
 *
 * All fields are optional - defaults come from constants.ts.
 */
export interface StreamControllerOpts {
    /**
     * Pause when this many items are unacknowledged.
     * Default: STREAM_HIGH_WATER (1000)
     */
    highWater?: number;

    /**
     * Resume when unacknowledged count falls to this.
     * Default: STREAM_LOW_WATER (100)
     */
    lowWater?: number;

    /**
     * Abort if no ping for this many milliseconds.
     * Default: STREAM_STALL_TIMEOUT (5000)
     */
    stallTimeout?: number;
}

/**
 * Resolved configuration with all values required.
 */
export interface StreamControllerConfig {
    highWater: number;
    lowWater: number;
    stallTimeout: number;
}
