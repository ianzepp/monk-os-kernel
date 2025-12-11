/**
 * clockd - Clock Daemon
 *
 * Simple daemon that prints the current time to the console every 60 seconds.
 * Demonstrates the basic app skeleton pattern with tick subscription.
 *
 * PURPOSE
 * =======
 * Provides a minimal example of a tick-based daemon. Can be extended to:
 * - Broadcast time updates to connected displays
 * - Trigger time-based events
 * - Synchronize clocks across the system
 *
 * @module rom/app/clockd
 */

import {
    getpid,
    println,
    onSignal,
    onTick,
    subscribeTicks,
} from '@rom/lib/process/index.js';

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const pid = await getpid();

    await println(`clockd: starting (pid ${pid})`);

    // Handle shutdown
    let running = true;

    onSignal(() => {
        running = false;
        println('clockd: received shutdown signal');
    });

    // Subscribe to kernel ticks
    await subscribeTicks();
    await println('clockd: subscribed to kernel ticks');

    // Tick handler - print time every 60 ticks (once per minute)
    onTick(async (_dt, _now, seq) => {
        if (!running) {
            return;
        }

        // Only print every 60 ticks
        if (seq % 60 !== 0) {
            return;
        }

        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        await println(`clockd: ${timeStr}`);
    });

    // Keep running
    while (running) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await println('clockd: shutdown complete');
}
