/**
 * Tick System - Kernel-driven clock for AI processes
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The tick system provides a regular "heartbeat" signal to subscribed processes.
 * Like a CPU clock cycle, it gives AI processes (monks) regular opportunities
 * to act autonomously without external stimulus.
 *
 * DESIGN DECISIONS
 * ================
 * - OPT-IN: Processes must subscribe to receive ticks (avoids wasted cycles)
 * - SIGNAL-BASED: Uses existing signal infrastructure (SignalMessage)
 * - SELF-MANAGED: Processes manage their own context/budget per tick
 * - BEST-EFFORT: Tick delivery is non-blocking; slow processes may miss ticks
 *
 * INVARIANTS
 * ==========
 * INV-1: Tick sequence number is monotonically increasing
 * INV-2: Dead processes are cleaned from subscribers on each tick
 * INV-3: dt reflects actual elapsed time (may exceed interval under load)
 *
 * @module kernel/kernel/tick
 */

import type { Kernel } from '../kernel.js';
import type { TickPayload } from '../types.js';
import { SIGTICK, TICK_INTERVAL_MS } from '../types.js';
import { deliverSignal } from './deliver-signal.js';
import { printk } from './printk.js';
import type { TimerHandle } from '@src/hal/timer.js';

// =============================================================================
// TICK STATE
// =============================================================================

/**
 * Tick system state.
 *
 * WHY MODULE-LEVEL: Single tick broadcaster per kernel instance.
 * State is managed per-kernel via the tickStates WeakMap.
 */
interface TickState {
    /** Timestamp of last tick (ms since epoch) */
    lastTick: number;

    /** Monotonic tick sequence number */
    seq: number;

    /** Subscribed process UUIDs */
    subscribers: Set<string>;

    /** Timer handle for cancellation */
    timerHandle: TimerHandle | null;
}

/**
 * Per-kernel tick state.
 *
 * WHY WEAKMAP: Allows garbage collection when kernel is destroyed.
 * Each kernel instance gets its own independent tick state.
 */
const tickStates = new WeakMap<Kernel, TickState>();

/**
 * Get or create tick state for a kernel.
 */
function getTickState(kernel: Kernel): TickState {
    let state = tickStates.get(kernel);

    if (!state) {
        state = {
            lastTick: Date.now(),
            seq: 0,
            subscribers: new Set(),
            timerHandle: null,
        };
        tickStates.set(kernel, state);
    }

    return state;
}

// =============================================================================
// TICK LIFECYCLE
// =============================================================================

/**
 * Start the tick broadcaster.
 *
 * Called during kernel boot after init is created.
 * Creates an interval timer that broadcasts SIGTICK to all subscribers.
 *
 * WHY HAL TIMER: Uses HAL's timer device for consistency and testability.
 * Tests can inject mock timers to control tick timing.
 *
 * @param kernel - Kernel instance
 */
export function startTick(kernel: Kernel): void {
    const state = getTickState(kernel);

    // Guard against double start
    if (state.timerHandle) {
        printk(kernel, 'tick', 'Tick broadcaster already running');
        return;
    }

    state.lastTick = Date.now();
    state.seq = 0;

    printk(kernel, 'tick', `Starting tick broadcaster (interval=${TICK_INTERVAL_MS}ms)`);

    state.timerHandle = kernel.hal.timer.interval(TICK_INTERVAL_MS, () => {
        broadcastTick(kernel);
    });
}

/**
 * Stop the tick broadcaster.
 *
 * Called during kernel shutdown.
 * Cancels the interval timer and clears subscribers.
 *
 * @param kernel - Kernel instance
 */
export function stopTick(kernel: Kernel): void {
    const state = getTickState(kernel);

    if (state.timerHandle) {
        printk(kernel, 'tick', 'Stopping tick broadcaster');
        kernel.hal.timer.cancel(state.timerHandle);
        state.timerHandle = null;
    }

    state.subscribers.clear();
}

// =============================================================================
// TICK BROADCAST
// =============================================================================

/**
 * Broadcast a tick to all subscribers.
 *
 * ALGORITHM:
 * 1. Calculate dt (time since last tick)
 * 2. Update state (lastTick, seq)
 * 3. Build payload
 * 4. Deliver SIGTICK to each subscriber
 * 5. Clean up dead subscribers
 *
 * WHY CLEANUP IN BROADCAST: Avoids separate cleanup timer.
 * Dead processes are removed naturally on each tick.
 *
 * @param kernel - Kernel instance
 */
function broadcastTick(kernel: Kernel): void {
    const state = getTickState(kernel);
    const now = Date.now();
    const dt = now - state.lastTick;

    state.lastTick = now;
    state.seq++;

    const payload: TickPayload = {
        dt,
        now,
        seq: state.seq,
    };

    // Track dead subscribers for cleanup
    const dead: string[] = [];

    for (const uuid of state.subscribers) {
        const proc = kernel.processes.get(uuid);

        if (!proc || proc.state === 'zombie') {
            dead.push(uuid);
            continue;
        }

        if (proc.state === 'running') {
            deliverSignal(kernel, proc, SIGTICK, payload);
        }
    }

    // Clean up dead subscribers
    for (const uuid of dead) {
        state.subscribers.delete(uuid);
    }
}

// =============================================================================
// SUBSCRIPTION MANAGEMENT
// =============================================================================

/**
 * Subscribe a process to receive ticks.
 *
 * @param kernel - Kernel instance
 * @param processId - Process UUID to subscribe
 */
export function subscribeTick(kernel: Kernel, processId: string): void {
    const state = getTickState(kernel);
    state.subscribers.add(processId);
    printk(kernel, 'tick', `Process ${processId.slice(0, 8)} subscribed to ticks`);
}

/**
 * Unsubscribe a process from ticks.
 *
 * @param kernel - Kernel instance
 * @param processId - Process UUID to unsubscribe
 */
export function unsubscribeTick(kernel: Kernel, processId: string): void {
    const state = getTickState(kernel);
    state.subscribers.delete(processId);
    printk(kernel, 'tick', `Process ${processId.slice(0, 8)} unsubscribed from ticks`);
}

/**
 * Check if a process is subscribed to ticks.
 *
 * @param kernel - Kernel instance
 * @param processId - Process UUID to check
 * @returns true if subscribed
 */
export function isTickSubscriber(kernel: Kernel, processId: string): boolean {
    const state = getTickState(kernel);
    return state.subscribers.has(processId);
}

/**
 * Get current tick state for debugging/testing.
 *
 * @param kernel - Kernel instance
 * @returns Current tick state snapshot
 */
export function getTickInfo(kernel: Kernel): { seq: number; subscribers: number } {
    const state = getTickState(kernel);
    return {
        seq: state.seq,
        subscribers: state.subscribers.size,
    };
}
