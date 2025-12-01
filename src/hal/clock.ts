/**
 * Clock Device
 *
 * Wall clock and monotonic time sources.
 *
 * Bun touchpoints:
 * - Date.now() for wall clock time
 * - Bun.nanoseconds() for monotonic time
 * - performance.now() as alternative monotonic source
 *
 * Caveats:
 * - Wall clock (now()) can jump backward due to NTP, DST, or manual changes
 * - Always use monotonic() for measuring durations
 * - Bun.nanoseconds() returns number; we convert to bigint for the interface
 * - uptime() is calculated from first call, not actual process start
 *
 * Host leakage:
 * - now() reflects host system time, including NTP adjustments and
 *   manual clock changes. Monk processes see the same time as host.
 * - monotonic() is relative to process start, no meaningful leakage.
 */

/**
 * Clock device interface.
 */
export interface ClockDevice {
    /**
     * Current wall clock time.
     *
     * Bun: Date.now()
     *
     * Caveat: Can jump forward or backward due to NTP, DST,
     * or manual system time changes. Do NOT use for measuring
     * durations - use monotonic() instead.
     *
     * @returns Milliseconds since Unix epoch (1970-01-01T00:00:00Z)
     */
    now(): number;

    /**
     * Monotonic time that never goes backward.
     *
     * Bun: Bun.nanoseconds()
     *
     * Use this for measuring durations. The epoch is arbitrary
     * (typically process start), so only differences are meaningful.
     *
     * @returns Nanoseconds since arbitrary fixed point
     */
    monotonic(): bigint;

    /**
     * Time since OS boot.
     *
     * Note: In HAL context, "OS boot" means when the HAL was
     * initialized, not the host system boot time.
     *
     * @returns Milliseconds since kernel started
     */
    uptime(): number;
}

/**
 * Bun clock device implementation
 *
 * Bun touchpoints:
 * - Date.now() - wall clock in milliseconds
 * - Bun.nanoseconds() - monotonic in nanoseconds (returns number, not bigint)
 *
 * Caveats:
 * - Bun.nanoseconds() epoch is process start
 * - We track boot time as first instantiation
 * - We convert to bigint to match interface (nanoseconds can exceed Number.MAX_SAFE_INTEGER)
 */
export class BunClockDevice implements ClockDevice {
    private bootMono: number;

    constructor() {
        this.bootMono = Bun.nanoseconds();
    }

    now(): number {
        return Date.now();
    }

    monotonic(): bigint {
        return BigInt(Bun.nanoseconds());
    }

    uptime(): number {
        // Convert nanoseconds difference to milliseconds
        const elapsed = Bun.nanoseconds() - this.bootMono;
        return Math.floor(elapsed / 1_000_000);
    }
}

/**
 * Mock clock device for testing
 *
 * Allows manual time control for deterministic tests.
 *
 * Usage:
 *   const clock = new MockClockDevice();
 *   clock.set(1000);  // Set wall clock to 1 second past epoch
 *   clock.advance(500);  // Advance both wall and monotonic by 500ms
 */
export class MockClockDevice implements ClockDevice {
    private wallTime: number = 0;
    private monoTime: bigint = 0n;
    private bootTime: number = 0;

    /**
     * Set wall clock time.
     * Does not affect monotonic time.
     */
    set(ms: number): void {
        this.wallTime = ms;
    }

    /**
     * Advance both wall and monotonic time.
     */
    advance(ms: number): void {
        this.wallTime += ms;
        this.monoTime += BigInt(ms) * 1_000_000n;
    }

    /**
     * Set monotonic time directly (nanoseconds).
     */
    setMono(ns: bigint): void {
        this.monoTime = ns;
    }

    /**
     * Reset to initial state.
     */
    reset(): void {
        this.wallTime = 0;
        this.monoTime = 0n;
        this.bootTime = 0;
    }

    now(): number {
        return this.wallTime;
    }

    monotonic(): bigint {
        return this.monoTime;
    }

    uptime(): number {
        return this.wallTime - this.bootTime;
    }
}
