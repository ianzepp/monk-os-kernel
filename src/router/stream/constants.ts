/**
 * Stream Constants - Backpressure thresholds and timing
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * These constants control the backpressure behavior for streaming syscalls.
 * The kernel produces Response items; the consumer (userland process) consumes
 * them. To prevent unbounded buffering when the producer is faster than the
 * consumer, we track items sent vs. acknowledged and pause production when
 * the gap exceeds HIGH_WATER.
 *
 * FLOW CONTROL MODEL
 * ==================
 *
 *   Producer (kernel)              Consumer (userland)
 *        │                              │
 *        │──── item ────────────────────>│
 *        │──── item ────────────────────>│
 *        │       ...                     │
 *        │<──── ping(processed=N) ───────│  (every PING_INTERVAL ms)
 *        │                               │
 *   [gap = sent - acked]                 │
 *   [if gap >= HIGH_WATER: pause]        │
 *   [if gap <= LOW_WATER: resume]        │
 *
 * WHY TWO THRESHOLDS (HYSTERESIS)
 * ===============================
 * Using a single threshold causes oscillation: producer pauses at N, consumer
 * processes one item, producer resumes, immediately hits N again, pauses...
 * The LOW_WATER threshold creates a hysteresis band that prevents this churn.
 *
 * @module router/stream/constants
 */

// =============================================================================
// BACKPRESSURE THRESHOLDS
// =============================================================================

/**
 * Pause production when this many items are unacknowledged.
 *
 * WHY 1000: Balances memory usage vs. throughput. At 1KB average per item,
 * this caps buffering at ~1MB. Larger values improve throughput by reducing
 * pause/resume cycles but increase memory pressure.
 *
 * TODO: Consider byte-based thresholds for more accurate memory control.
 * A stream of 1000 small integers uses far less memory than 1000 1MB chunks.
 */
export const STREAM_HIGH_WATER = 1000;

/**
 * Resume production when unacknowledged count falls to this level.
 *
 * WHY 100: Creates a 900-item hysteresis band. Producer runs until hitting
 * 1000, pauses, consumer drains to 100, producer resumes. This reduces
 * pause/resume frequency while keeping memory bounded.
 */
export const STREAM_LOW_WATER = 100;

// =============================================================================
// TIMING
// =============================================================================

/**
 * Consumer pings kernel every this many milliseconds.
 *
 * WHY 100ms: Frequent enough to keep producer running smoothly, infrequent
 * enough to avoid IPC overhead. At 1000 items/sec, consumer processes ~100
 * items between pings.
 */
export const STREAM_PING_INTERVAL = 100;

/**
 * Abort stream if no ping received for this many milliseconds.
 *
 * WHY 5000ms: Long enough to survive GC pauses and temporary consumer
 * stalls. Short enough to detect dead consumers and free resources.
 * 50x the ping interval provides margin for occasional missed pings.
 */
export const STREAM_STALL_TIMEOUT = 5000;
