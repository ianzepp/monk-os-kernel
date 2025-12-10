/**
 * timerd - Timer Daemon
 *
 * One-shot delayed syscall execution using EMS-backed timer entities.
 *
 * Timers are stored as 'timer' entities and can be managed via:
 *   ems:create timer { fire_at, syscall, args }
 *   ems:update timer <id> { fire_at: newTime }  // Reschedule
 *   ems:delete timer <id>                        // Cancel
 *   ems:select timer { fired: false }            // List pending
 *
 * Examples:
 *
 *   // Expire an order in 30 minutes
 *   ems:create timer {
 *       fire_at: "2024-12-09T22:00:00Z",
 *       syscall: "ems:update",
 *       args: ["order", "abc123", { "status": "expired" }]
 *   }
 *
 *   // Delete a session in 24 hours
 *   ems:create timer {
 *       fire_at: "2024-12-10T21:00:00Z",
 *       syscall: "ems:delete",
 *       args: ["auth.session", "xyz789"]
 *   }
 *
 *   // Send a notification at a specific time
 *   ems:create timer {
 *       fire_at: "2024-12-09T15:00:00Z",
 *       syscall: "ems:create",
 *       args: ["notification", { "user_id": "u1", "message": "Reminder!" }]
 *   }
 */

import {
    call,
    collect,
    getpid,
    println,
    eprintln,
    onSignal,
    onTick,
    subscribeTicks,
} from '@rom/lib/process/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface Timer {
    id: string;
    name: string | null;
    fire_at: string;
    syscall: string;
    args: unknown[] | null;
    fired: boolean;
    fired_at: string | null;
    result: unknown | null;
    error: string | null;
    owner_pid: string | null;
    context: unknown | null;
}

// =============================================================================
// TIMER EXECUTION
// =============================================================================

/**
 * Execute a timer's syscall.
 */
async function executeTimer(timer: Timer): Promise<void> {
    const timerName = timer.name ?? timer.id;

    await println(`timerd: firing timer '${timerName}' (${timer.syscall})`);

    const firedAt = new Date().toISOString();
    let result: unknown = null;
    let error: string | null = null;

    try {
        const args = timer.args ?? [];

        result = await call(timer.syscall, ...args);
    }
    catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await eprintln(`timerd: timer '${timerName}' failed: ${error}`);
    }

    // Update timer status
    try {
        await call('ems:update', 'timer', timer.id, {
            fired: true,
            fired_at: firedAt,
            result: result,
            error: error,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`timerd: failed to update timer status: ${msg}`);
    }

    if (!error) {
        await println(`timerd: timer '${timerName}' completed successfully`);
    }
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const pid = await getpid();

    await println(`timerd: starting (pid ${pid})`);

    // Handle shutdown
    let running = true;

    onSignal(() => {
        running = false;
        println('timerd: received shutdown signal');
    });

    // Subscribe to kernel ticks
    await subscribeTicks();
    await println('timerd: subscribed to kernel ticks');

    // Tick handler - check timers every second
    onTick(async (_dt, _now, seq) => {
        if (!running) {
            return;
        }

        // Heartbeat every 60 ticks
        if (seq % 60 === 0) {
            await println(`timerd: heartbeat tick=${seq}`);
        }

        const now = new Date().toISOString();

        // Query due timers
        let timers: Timer[];

        try {
            timers = await collect<Timer>('ems:select', 'timer', {
                where: {
                    fired: false,
                },
            });
        }
        catch {
            // Model may not exist yet on first boot
            return;
        }

        // Filter to timers that are due
        const dueTimers = timers.filter(t => t.fire_at <= now);

        // Execute each due timer
        for (const timer of dueTimers) {
            // Run timer execution (don't await to avoid blocking tick)
            executeTimer(timer).catch(async err => {
                const msg = err instanceof Error ? err.message : String(err);
                const timerName = timer.name ?? timer.id;

                await eprintln(`timerd: unhandled error in timer '${timerName}': ${msg}`);
            });
        }
    });

    // Keep running
    while (running) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await println('timerd: shutdown complete');
}
