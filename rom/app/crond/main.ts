/**
 * crond - Cron Daemon
 *
 * Scheduled job execution using EMS-backed job entities.
 *
 * Jobs are stored as 'cron.job' entities and can be managed via:
 *   ems:create cron.job { name, spec, command, enabled }
 *   ems:update cron.job <id> { enabled: false }
 *   ems:select cron.job { enabled: true }
 *   ems:delete cron.job <id>
 *
 * Cron spec format: standard 5-field cron expression
 *   minute (0-59)
 *   hour (0-23)
 *   day of month (1-31)
 *   month (1-12)
 *   day of week (0-6, 0=Sunday)
 *
 * Examples:
 *   "* * * * *"     - Every minute
 *   "0 * * * *"     - Every hour
 *   "0 0 * * *"     - Daily at midnight
 *   "0 0 * * 0"     - Weekly on Sunday
 *   "0 0 1 * *"     - Monthly on the 1st
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
    spawn,
    wait,
} from '@rom/lib/process/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface CronJob {
    id: string;
    name: string;
    spec: string;
    command: string;
    args?: string[];
    enabled: boolean;
    next_run: string | null;
    last_run: string | null;
    last_status: number | null;
    last_error: string | null;
    run_count: number;
    fail_count: number;
    timeout: number | null;
    retry_on_fail: boolean;
    max_retries: number;
}

// =============================================================================
// CRON PARSING
// =============================================================================

/**
 * Parse a cron field into a set of valid values.
 */
function parseField(field: string, min: number, max: number): Set<number> {
    const values = new Set<number>();

    for (const part of field.split(',')) {
        if (part === '*') {
            for (let i = min; i <= max; i++) values.add(i);
        }
        else if (part.includes('/')) {
            const splitParts = part.split('/');
            const range = splitParts[0] ?? '*';
            const stepStr = splitParts[1] ?? '1';
            const step = parseInt(stepStr, 10);
            const start = range === '*' ? min : parseInt(range, 10);

            for (let i = start; i <= max; i += step) values.add(i);
        }
        else if (part.includes('-')) {
            const splitParts = part.split('-');
            const start = parseInt(splitParts[0] ?? '0', 10);
            const end = parseInt(splitParts[1] ?? '0', 10);

            for (let i = start; i <= end; i++) values.add(i);
        }
        else {
            values.add(parseInt(part, 10));
        }
    }

    return values;
}

/**
 * Check if a cron spec matches the given date.
 */
function matchesCron(spec: string, date: Date): boolean {
    const parts = spec.trim().split(/\s+/);

    if (parts.length !== 5) {
        return false;
    }

    const minuteSpec = parts[0] ?? '*';
    const hourSpec = parts[1] ?? '*';
    const daySpec = parts[2] ?? '*';
    const monthSpec = parts[3] ?? '*';
    const dowSpec = parts[4] ?? '*';

    const minute = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const dow = date.getDay();

    return (
        parseField(minuteSpec, 0, 59).has(minute) &&
        parseField(hourSpec, 0, 23).has(hour) &&
        parseField(daySpec, 1, 31).has(day) &&
        parseField(monthSpec, 1, 12).has(month) &&
        parseField(dowSpec, 0, 6).has(dow)
    );
}

/**
 * Calculate the next run time for a cron spec.
 */
function getNextRun(spec: string, after: Date = new Date()): Date {
    const next = new Date(after);

    next.setSeconds(0);
    next.setMilliseconds(0);
    next.setMinutes(next.getMinutes() + 1);

    // Search up to 1 year ahead
    const limit = new Date(after);

    limit.setFullYear(limit.getFullYear() + 1);

    while (next < limit) {
        if (matchesCron(spec, next)) {
            return next;
        }

        next.setMinutes(next.getMinutes() + 1);
    }

    // Fallback: 1 year from now
    return limit;
}

// =============================================================================
// JOB EXECUTION
// =============================================================================

/**
 * Execute a cron job.
 */
async function executeJob(job: CronJob): Promise<void> {
    await println(`crond: running job '${job.name}' (${job.command})`);

    const startTime = new Date().toISOString();
    let exitCode = 0;
    let errorMsg: string | null = null;

    try {
        const pid = await spawn(job.command);
        const status = await wait(pid, job.timeout ? job.timeout * 1000 : undefined);

        exitCode = status.code;

        if (exitCode !== 0) {
            errorMsg = `Exit code ${exitCode}`;
        }
    }
    catch (err) {
        exitCode = 1;
        errorMsg = err instanceof Error ? err.message : String(err);
        await eprintln(`crond: job '${job.name}' failed: ${errorMsg}`);
    }

    // Update job status
    const nextRun = getNextRun(job.spec);

    try {
        await call('ems:update', 'cron.job', job.id, {
            last_run: startTime,
            last_status: exitCode,
            last_error: errorMsg,
            next_run: nextRun.toISOString(),
            run_count: job.run_count + 1,
            fail_count: exitCode !== 0 ? job.fail_count + 1 : job.fail_count,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`crond: failed to update job status: ${msg}`);
    }

    if (exitCode === 0) {
        await println(`crond: job '${job.name}' completed successfully`);
    }
    else {
        await eprintln(`crond: job '${job.name}' failed with code ${exitCode}`);
    }
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const pid = await getpid();

    await println(`crond: starting (pid ${pid})`);

    // Handle shutdown
    let running = true;

    onSignal(() => {
        running = false;
        println('crond: received shutdown signal');
    });

    // Subscribe to kernel ticks
    await subscribeTicks();
    await println('crond: subscribed to kernel ticks');

    // Track last check minute to avoid duplicate runs
    let lastCheckMinute = -1;

    // Tick handler - check jobs every minute
    onTick(async (_dt, _now, seq) => {
        if (!running) return;

        const now = new Date();
        const currentMinute = now.getMinutes();

        // Only check once per minute
        if (currentMinute === lastCheckMinute) {
            return;
        }

        lastCheckMinute = currentMinute;

        // Heartbeat every 60 ticks
        if (seq % 60 === 0) {
            await println(`crond: heartbeat tick=${seq}`);
        }

        // Query enabled jobs
        let jobs: CronJob[];

        try {
            jobs = await collect<CronJob>('ems:select', 'cron.job', {
                where: { enabled: true },
            });
        }
        catch {
            // Model may not exist yet on first boot
            return;
        }

        // Check each job
        for (const job of jobs) {
            if (matchesCron(job.spec, now)) {
                // Run job in background (don't await)
                executeJob(job).catch(async err => {
                    const msg = err instanceof Error ? err.message : String(err);

                    await eprintln(`crond: unhandled error in job '${job.name}': ${msg}`);
                });
            }
        }
    });

    // Keep running
    while (running) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await println('crond: shutdown complete');
}
