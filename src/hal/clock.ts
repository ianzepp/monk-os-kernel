/**
 * Clock Device - Time and monotonic clock sources
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Clock Device provides two fundamental time services: wall clock time (now())
 * and monotonic time (monotonic()). These serve different purposes and have
 * different guarantees.
 *
 * Wall clock time represents the current real-world time and is subject to
 * adjustments by NTP, DST changes, and manual system clock modifications. It can
 * jump forward or backward. This makes it suitable for timestamps but dangerous
 * for measuring durations.
 *
 * Monotonic time is guaranteed never to go backward. It measures elapsed time from
 * an arbitrary epoch (typically process start). This makes it the correct choice
 * for timeouts, performance measurements, and any duration calculations.
 *
 * The uptime() method provides a convenience wrapper around monotonic time,
 * calculating elapsed time since HAL initialization. In Monk OS context, "boot time"
 * refers to when the HAL was initialized, not the host system boot.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: now() returns milliseconds since Unix epoch (1970-01-01T00:00:00Z)
 * INV-2: monotonic() never decreases within a single process execution
 * INV-3: monotonic() returns nanoseconds (bigint to handle values > 2^53)
 * INV-4: uptime() never decreases within a single process execution
 * INV-5: uptime() returns milliseconds since HAL initialization
 *
 * CONCURRENCY MODEL
 * =================
 * All ClockDevice methods are synchronous and thread-safe. JavaScript is
 * single-threaded, so no locking is required. The underlying Bun APIs
 * (Date.now(), Bun.nanoseconds()) are implemented in native code and atomic.
 *
 * Multiple processes may call these methods concurrently via syscalls. The
 * kernel will serialize calls through the event loop, but each call is
 * independent and non-blocking.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: No shared mutable state except bootMono, which is set once in constructor
 * RC-2: All operations are pure reads of system state
 * RC-3: bootMono is captured atomically in constructor, no TOCTOU issues
 *
 * MEMORY MANAGEMENT
 * =================
 * - ClockDevice instances have no cleanup requirements
 * - No resources to release, no handles to close
 * - bootMono is a single number, O(1) memory footprint
 * - Mock implementations may accumulate state for testing
 *
 * @module hal/clock
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Clock device interface.
 *
 * WHY: Provides abstraction over time sources for testability and portability.
 * The interface allows swapping between real time (Bun), mock time (testing),
 * or alternative implementations (simulated time, logical clocks).
 */
export interface ClockDevice {
    /**
     * Current wall clock time.
     *
     * Bun implementation: Date.now()
     *
     * CAVEAT: Can jump forward or backward due to NTP, DST, or manual system
     * time changes. Do NOT use for measuring durations - use monotonic() instead.
     *
     * WHY: Provides real-world timestamps for logging, database records, and
     * user-visible time displays. The millisecond precision matches JavaScript
     * Date and database timestamp columns.
     *
     * @returns Milliseconds since Unix epoch (1970-01-01T00:00:00Z)
     */
    now(): number;

    /**
     * Monotonic time that never goes backward.
     *
     * Bun implementation: Bun.nanoseconds()
     *
     * WHY: Essential for accurate duration measurement. The epoch is arbitrary
     * (typically process start), so only differences are meaningful. Used for
     * timeouts, performance measurement, and rate limiting.
     *
     * WHY nanoseconds: Sub-millisecond precision enables accurate profiling and
     * high-frequency operations. Bun.nanoseconds() provides native nanosecond
     * resolution on most platforms.
     *
     * WHY bigint: Nanoseconds overflow Number.MAX_SAFE_INTEGER (2^53) after
     * ~104 days. Using bigint ensures correctness for long-running processes.
     *
     * @returns Nanoseconds since arbitrary fixed point (process start)
     */
    monotonic(): bigint;

    /**
     * Time since OS boot.
     *
     * WHY: Provides a convenient way to measure total system uptime without
     * manually tracking boot time. Useful for diagnostics, logging, and
     * understanding system lifecycle.
     *
     * NOTE: In HAL context, "OS boot" means when the HAL was initialized,
     * not the host system boot time. This is the Monk OS boot time.
     *
     * INVARIANT: uptime() is always monotonically increasing (never decreases).
     *
     * @returns Milliseconds since kernel started (HAL initialization)
     */
    uptime(): number;
}

// =============================================================================
// MAIN IMPLEMENTATIONS
// =============================================================================

/**
 * Bun clock device implementation
 *
 * Bun touchpoints:
 * - Date.now() - Wall clock in milliseconds
 * - Bun.nanoseconds() - Monotonic clock in nanoseconds (returns number, not bigint)
 *
 * WHY these APIs: Date.now() is a standard JavaScript API with millisecond
 * precision, suitable for most timestamping needs. Bun.nanoseconds() provides
 * high-resolution monotonic time for accurate duration measurement.
 *
 * Caveats:
 * - Bun.nanoseconds() epoch is process start, not system boot
 * - We track "boot time" as first instantiation of BunClockDevice
 * - We convert Bun.nanoseconds() result to bigint to match interface
 * - Conversion is safe because nanoseconds may exceed Number.MAX_SAFE_INTEGER
 *
 * TESTABILITY: The interface allows dependency injection of mock clocks for tests.
 */
export class BunClockDevice implements ClockDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Monotonic time at construction (nanoseconds).
     *
     * WHY: Captured once at construction to provide a stable boot reference.
     * All uptime() calculations use this as the epoch.
     *
     * INVARIANT: Set once in constructor, never modified thereafter.
     *
     * RACE CONDITION: None - constructor runs atomically before any method calls.
     */
    private readonly bootMono: number;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Initialize clock device.
     *
     * WHY capture bootMono here: We need a stable reference point for uptime()
     * calculations. Capturing at construction ensures all instances share a
     * consistent view of when the "boot" occurred.
     */
    constructor() {
        this.bootMono = Bun.nanoseconds();
    }

    // =========================================================================
    // TIME SOURCES
    // =========================================================================

    /**
     * Get current wall clock time.
     *
     * WHY Date.now(): Standard JavaScript API, widely supported, millisecond
     * precision matches database timestamps and log formats.
     *
     * CAVEAT: Time can jump backward or forward due to NTP adjustments, DST
     * transitions, or manual clock changes. Never use for duration measurement.
     *
     * @returns Milliseconds since Unix epoch
     */
    now(): number {
        return Date.now();
    }

    /**
     * Get monotonic time.
     *
     * WHY Bun.nanoseconds(): Provides high-resolution monotonic time that never
     * goes backward. Essential for accurate timeout implementation and performance
     * measurement.
     *
     * WHY convert to bigint: JavaScript numbers lose precision beyond 2^53.
     * Nanoseconds overflow this after ~104 days. BigInt ensures correctness
     * for long-running processes.
     *
     * @returns Nanoseconds since process start
     */
    monotonic(): bigint {
        return BigInt(Bun.nanoseconds());
    }

    /**
     * Get time since boot.
     *
     * ALGORITHM:
     * 1. Get current monotonic time in nanoseconds
     * 2. Subtract boot time captured in constructor
     * 3. Convert nanoseconds to milliseconds (divide by 1,000,000)
     * 4. Floor to integer milliseconds
     *
     * WHY milliseconds: Provides sufficient precision for uptime reporting
     * while being compatible with Date.now() and easier to display/log.
     *
     * WHY floor: Ensures we never report fractional milliseconds, consistent
     * with Date.now() behavior.
     *
     * @returns Milliseconds since HAL initialization
     */
    uptime(): number {
        const elapsed = Bun.nanoseconds() - this.bootMono;

        return Math.floor(elapsed / 1_000_000);
    }
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Mock clock device for testing
 *
 * WHY: Enables deterministic time in tests. Tests can control time precisely,
 * verify timeout behavior, and simulate time-based scenarios without waiting.
 *
 * TESTABILITY: Allows manual time control for deterministic tests. Tests can
 * set specific times, advance time incrementally, and verify time-dependent
 * behavior without flakiness or delays.
 *
 * Usage:
 *   const clock = new MockClockDevice();
 *   clock.set(1000);        // Set wall clock to 1 second past epoch
 *   clock.advance(500);     // Advance both wall and monotonic by 500ms
 *   clock.setMono(1000n);   // Set monotonic time directly (nanoseconds)
 *   clock.reset();          // Reset to initial state
 */
export class MockClockDevice implements ClockDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Current wall clock time in milliseconds.
     *
     * WHY: Simulates Date.now() for testing. Tests can set this to specific
     * values to verify timestamp handling.
     */
    private wallTime: number = 0;

    /**
     * Current monotonic time in nanoseconds.
     *
     * WHY: Simulates Bun.nanoseconds() for testing. Tests can advance this
     * to verify timeout and duration calculations.
     */
    private monoTime: bigint = 0n;

    /**
     * Boot time reference for uptime calculation.
     *
     * WHY: Simulates bootMono capture. Tests can verify uptime() calculations
     * by comparing wallTime to this reference.
     */
    private bootTime: number = 0;

    // =========================================================================
    // CONTROL METHODS (testing only)
    // =========================================================================

    /**
     * Set wall clock time.
     *
     * WHY: Allows tests to simulate specific timestamps without affecting
     * monotonic time. Useful for testing timestamp formatting, date calculations,
     * and wall clock dependent logic.
     *
     * NOTE: Does not affect monotonic time. This simulates NTP adjustments or
     * manual clock changes.
     *
     * @param ms - Milliseconds since Unix epoch
     */
    set(ms: number): void {
        this.wallTime = ms;
    }

    /**
     * Advance both wall and monotonic time.
     *
     * WHY: Simulates normal time passage. Both clocks advance together, as
     * would happen in real execution. This is the most common test operation.
     *
     * @param ms - Milliseconds to advance
     */
    advance(ms: number): void {
        this.wallTime += ms;
        this.monoTime += BigInt(ms) * 1_000_000n;
    }

    /**
     * Set monotonic time directly (nanoseconds).
     *
     * WHY: Allows precise control of monotonic time for edge case testing.
     * Tests can verify behavior at specific nanosecond values or simulate
     * very long uptimes.
     *
     * @param ns - Nanoseconds since arbitrary epoch
     */
    setMono(ns: bigint): void {
        this.monoTime = ns;
    }

    /**
     * Reset to initial state.
     *
     * WHY: Allows test cleanup without creating new instances. Tests can
     * reset clock state between test cases for isolation.
     *
     * TESTABILITY: Enables test independence - each test starts with clean
     * clock state at time zero.
     */
    reset(): void {
        this.wallTime = 0;
        this.monoTime = 0n;
        this.bootTime = 0;
    }

    // =========================================================================
    // CLOCKDEVICE IMPLEMENTATION
    // =========================================================================

    /**
     * Get simulated wall clock time.
     *
     * @returns Current mock time in milliseconds since epoch
     */
    now(): number {
        return this.wallTime;
    }

    /**
     * Get simulated monotonic time.
     *
     * @returns Current mock monotonic time in nanoseconds
     */
    monotonic(): bigint {
        return this.monoTime;
    }

    /**
     * Get simulated uptime.
     *
     * WHY wallTime - bootTime: Simulates elapsed time calculation using
     * wall clock. In production, this uses monotonic time, but for testing
     * wall clock is simpler and equivalent.
     *
     * @returns Mock uptime in milliseconds
     */
    uptime(): number {
        return this.wallTime - this.bootTime;
    }
}
