/**
 * Crontab - Scheduled Job Management
 *
 * Database-centric cron implementation using the processes table.
 * Jobs are stored in the infrastructure database and executed by
 * a scheduler that polls for due jobs.
 *
 * Architecture:
 *   - Jobs stored in public.processes with type='cron'
 *   - Scheduler runs every minute, picks up due jobs
 *   - Jobs execute shell commands in tenant context via TTY executor
 *   - FOR UPDATE SKIP LOCKED prevents double-execution in clusters
 *
 * Usage:
 *   // Create a job
 *   await Crontab.create(systemInit, {
 *       schedule: '0 * * * *',  // hourly
 *       command: 'select count(*) from users',
 *   });
 *
 *   // List jobs
 *   const jobs = await Crontab.list(tenantName);
 *
 *   // Start scheduler (call once at server startup)
 *   Crontab.startScheduler();
 */

import { createAdapter } from '@src/lib/database/index.js';
import type { DatabaseAdapter } from '@src/lib/database/adapter.js';
import type { SystemInit } from '@src/lib/system.js';

// =============================================================================
// CRON EXPRESSION PARSER
// =============================================================================

/**
 * Generate a range of numbers
 */
function range(start: number, end: number, step = 1): number[] {
    const result: number[] = [];
    for (let i = start; i <= end; i += step) {
        result.push(i);
    }
    return result;
}

/**
 * Parse a single cron field into matching values
 *
 * Supports:
 *   *        - all values
 *   5        - specific value
 *   1,3,5    - list of values
 *   1-5      - range
 *   * /15     - step (every 15)
 *   1-10/2   - range with step
 */
function parseCronField(field: string, min: number, max: number): number[] {
    const values = new Set<number>();

    for (const part of field.split(',')) {
        if (part === '*') {
            range(min, max).forEach(v => values.add(v));
        } else if (part.includes('/')) {
            const [rangeStr, stepStr] = part.split('/');
            const step = parseInt(stepStr, 10);
            let start = min;
            let end = max;

            if (rangeStr !== '*') {
                if (rangeStr.includes('-')) {
                    [start, end] = rangeStr.split('-').map(n => parseInt(n, 10));
                } else {
                    start = parseInt(rangeStr, 10);
                }
            }

            range(start, end, step).forEach(v => values.add(v));
        } else if (part.includes('-')) {
            const [start, end] = part.split('-').map(n => parseInt(n, 10));
            range(start, end).forEach(v => values.add(v));
        } else {
            values.add(parseInt(part, 10));
        }
    }

    return Array.from(values).sort((a, b) => a - b);
}

/**
 * Parsed cron expression
 */
interface ParsedCron {
    minutes: number[];
    hours: number[];
    daysOfMonth: number[];
    months: number[];
    daysOfWeek: number[];
}

/**
 * Parse a cron expression
 *
 * Format: minute hour day-of-month month day-of-week
 *         0-59   0-23  1-31         1-12  0-6 (0=Sunday)
 */
function parseCron(expr: string): ParsedCron {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
    }

    return {
        minutes: parseCronField(parts[0], 0, 59),
        hours: parseCronField(parts[1], 0, 23),
        daysOfMonth: parseCronField(parts[2], 1, 31),
        months: parseCronField(parts[3], 1, 12),
        daysOfWeek: parseCronField(parts[4], 0, 6),
    };
}

/**
 * Check if a date matches the cron expression
 */
function matchesCron(date: Date, cron: ParsedCron): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1; // JS months are 0-indexed
    const dayOfWeek = date.getDay();

    // Month and time must always match
    if (!cron.minutes.includes(minute)) return false;
    if (!cron.hours.includes(hour)) return false;
    if (!cron.months.includes(month)) return false;

    // Day matching: DOM and DOW are OR'd (standard cron behavior)
    // If both are restricted (not *), either can match
    const domRestricted = cron.daysOfMonth.length < 31;
    const dowRestricted = cron.daysOfWeek.length < 7;

    if (domRestricted && dowRestricted) {
        // Either day-of-month OR day-of-week can match
        return cron.daysOfMonth.includes(dayOfMonth) || cron.daysOfWeek.includes(dayOfWeek);
    } else if (domRestricted) {
        return cron.daysOfMonth.includes(dayOfMonth);
    } else if (dowRestricted) {
        return cron.daysOfWeek.includes(dayOfWeek);
    }

    return true; // Both are *, any day matches
}

/**
 * Get the next run time for a cron expression
 *
 * Iterates minute-by-minute from the start time until a match is found.
 * Limited to 2 years ahead to prevent infinite loops.
 */
function getNextRun(expr: string, from: Date = new Date()): Date {
    const cron = parseCron(expr);

    // Start from the next minute
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);

    // Limit search to 2 years
    const maxDate = new Date(from);
    maxDate.setFullYear(maxDate.getFullYear() + 2);

    while (next < maxDate) {
        if (matchesCron(next, cron)) {
            return next;
        }

        // Advance by 1 minute
        next.setMinutes(next.getMinutes() + 1);
    }

    throw new Error(`No matching time found within 2 years for: ${expr}`);
}

/**
 * Validate a cron expression
 */
function isValidCron(expr: string): boolean {
    try {
        parseCron(expr);
        return true;
    } catch {
        return false;
    }
}

// =============================================================================
// CRONTAB CLASS
// =============================================================================

/**
 * Cron job record
 */
export interface CronJob {
    pid: number;
    tenant: string;
    uid: string;
    command: string;
    schedule: string;
    enabled: boolean;
    lastRun: Date | null;
    nextRun: Date | null;
    lastExitCode: number | null;
    lastError: string | null;
    createdAt: Date;
}

/**
 * Options for creating a cron job
 */
export interface CreateCronOptions {
    schedule: string;
    command: string;
    enabled?: boolean;
}

/**
 * Get the public schema adapter for crontab operations
 */
async function getPublicAdapter(): Promise<DatabaseAdapter> {
    const adapter = createAdapter({
        dbType: 'postgresql',
        db: process.env.MONK_PG_DATABASE || 'monk',
        ns: 'public',
    });
    await adapter.connect();
    return adapter;
}

/**
 * Crontab management class
 */
export class Crontab {
    private static schedulerInterval: NodeJS.Timeout | null = null;
    private static isRunning = false;

    /**
     * Create a new cron job
     */
    static async create(init: SystemInit, options: CreateCronOptions): Promise<number> {
        // Validate cron expression
        if (!isValidCron(options.schedule)) {
            throw new Error(`Invalid cron expression: ${options.schedule}`);
        }

        const nextRun = getNextRun(options.schedule);
        const adapter = await getPublicAdapter();

        try {
            const result = await adapter.query<{ pid: number }>(
                `INSERT INTO processes (
                    tenant, db_type, db_name, ns_name,
                    uid, access,
                    state,
                    comm, cmdline, cwd,
                    type, cron_expr, next_run_at
                ) VALUES (
                    $1, $2, $3, $4,
                    $5, $6,
                    $7,
                    'cron', $8, '/',
                    'cron', $9, $10
                ) RETURNING pid`,
                [
                    init.tenant,
                    init.dbType,
                    init.dbName,
                    init.nsName,
                    init.userId,
                    init.access,
                    options.enabled === false ? 'T' : 'S', // T=stopped (disabled), S=sleeping (enabled)
                    [options.command],
                    options.schedule,
                    nextRun,
                ]
            );

            return result.rows[0].pid;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * List cron jobs for a tenant
     */
    static async list(tenantName: string): Promise<CronJob[]> {
        const adapter = await getPublicAdapter();

        try {
            const result = await adapter.query<{
                pid: number;
                tenant: string;
                uid: string;
                cmdline: string[];
                cron_expr: string;
                state: string;
                started_at: Date | null;
                next_run_at: Date | null;
                exit_code: number | null;
                error: string | null;
                created_at: Date;
            }>(
                `SELECT pid, tenant, uid, cmdline, cron_expr, state,
                        started_at, next_run_at, exit_code, error, created_at
                 FROM processes
                 WHERE tenant = $1 AND type = 'cron'
                 ORDER BY created_at DESC`,
                [tenantName]
            );

            return result.rows.map(row => ({
                pid: row.pid,
                tenant: row.tenant,
                uid: row.uid,
                command: Array.isArray(row.cmdline) ? row.cmdline[0] : row.cmdline,
                schedule: row.cron_expr,
                enabled: row.state !== 'T' && row.state !== 'X',
                lastRun: row.started_at,
                nextRun: row.next_run_at,
                lastExitCode: row.exit_code,
                lastError: row.error,
                createdAt: row.created_at,
            }));
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Get a cron job by PID
     */
    static async get(tenantName: string, pid: number): Promise<CronJob | null> {
        const jobs = await this.list(tenantName);
        return jobs.find(j => j.pid === pid) || null;
    }

    /**
     * Enable a cron job
     */
    static async enable(tenantName: string, pid: number): Promise<boolean> {
        const adapter = await getPublicAdapter();

        try {
            const job = await this.get(tenantName, pid);
            if (!job) return false;

            const nextRun = getNextRun(job.schedule);

            const result = await adapter.query(
                `UPDATE processes
                 SET state = 'S', next_run_at = $1
                 WHERE pid = $2 AND tenant = $3 AND type = 'cron'`,
                [nextRun, pid, tenantName]
            );

            return result.rowCount > 0;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Disable a cron job
     */
    static async disable(tenantName: string, pid: number): Promise<boolean> {
        const adapter = await getPublicAdapter();

        try {
            const result = await adapter.query(
                `UPDATE processes
                 SET state = 'T', next_run_at = NULL
                 WHERE pid = $1 AND tenant = $2 AND type = 'cron'`,
                [pid, tenantName]
            );

            return result.rowCount > 0;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Delete a cron job
     */
    static async delete(tenantName: string, pid: number): Promise<boolean> {
        const adapter = await getPublicAdapter();

        try {
            const result = await adapter.query(
                `DELETE FROM processes
                 WHERE pid = $1 AND tenant = $2 AND type = 'cron'`,
                [pid, tenantName]
            );

            return result.rowCount > 0;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Update a cron job's schedule
     */
    static async updateSchedule(
        tenantName: string,
        pid: number,
        schedule: string
    ): Promise<boolean> {
        // Validate cron expression
        if (!isValidCron(schedule)) {
            throw new Error(`Invalid cron expression: ${schedule}`);
        }

        const adapter = await getPublicAdapter();

        try {
            const nextRun = getNextRun(schedule);

            const result = await adapter.query(
                `UPDATE processes
                 SET cron_expr = $1, next_run_at = $2
                 WHERE pid = $3 AND tenant = $4 AND type = 'cron' AND state != 'X'`,
                [schedule, nextRun, pid, tenantName]
            );

            return result.rowCount > 0;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Update a cron job's command
     */
    static async updateCommand(
        tenantName: string,
        pid: number,
        command: string
    ): Promise<boolean> {
        const adapter = await getPublicAdapter();

        try {
            const result = await adapter.query(
                `UPDATE processes
                 SET cmdline = $1
                 WHERE pid = $2 AND tenant = $3 AND type = 'cron' AND state != 'X'`,
                [[command], pid, tenantName]
            );

            return result.rowCount > 0;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Get due jobs (for scheduler)
     *
     * Uses FOR UPDATE SKIP LOCKED to prevent double-execution in clusters.
     * Returns jobs and marks them as running.
     */
    static async getDueJobs(): Promise<Array<{
        pid: number;
        tenant: string;
        dbType: string;
        dbName: string;
        nsName: string;
        uid: string;
        access: string;
        command: string;
        schedule: string;
    }>> {
        const adapter = await getPublicAdapter();

        try {
            await adapter.beginTransaction();

            // Select and lock due jobs
            const result = await adapter.query<{
                pid: number;
                tenant: string;
                db_type: string;
                db_name: string;
                ns_name: string;
                uid: string;
                access: string;
                cmdline: string[];
                cron_expr: string;
            }>(
                `SELECT pid, tenant, db_type, db_name, ns_name, uid, access, cmdline, cron_expr
                 FROM processes
                 WHERE type = 'cron'
                   AND state = 'S'
                   AND next_run_at <= NOW()
                 FOR UPDATE SKIP LOCKED`
            );

            if (result.rows.length === 0) {
                await adapter.commit();
                return [];
            }

            // Mark as running
            const pids = result.rows.map(r => r.pid);
            await adapter.query(
                `UPDATE processes
                 SET state = 'R', started_at = NOW()
                 WHERE pid = ANY($1)`,
                [pids]
            );

            await adapter.commit();

            return result.rows.map(row => ({
                pid: row.pid,
                tenant: row.tenant,
                dbType: row.db_type,
                dbName: row.db_name,
                nsName: row.ns_name,
                uid: row.uid,
                access: row.access,
                command: Array.isArray(row.cmdline) ? row.cmdline[0] : row.cmdline,
                schedule: row.cron_expr,
            }));
        } catch (error) {
            await adapter.rollback();
            throw error;
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Mark job as completed and schedule next run
     */
    static async completeJob(
        pid: number,
        exitCode: number,
        error: string | null = null
    ): Promise<void> {
        const adapter = await getPublicAdapter();

        try {
            // Get the job's schedule
            const jobResult = await adapter.query<{ cron_expr: string }>(
                `SELECT cron_expr FROM processes WHERE pid = $1`,
                [pid]
            );

            if (jobResult.rows.length === 0) return;

            const nextRun = getNextRun(jobResult.rows[0].cron_expr);

            await adapter.query(
                `UPDATE processes
                 SET state = 'S',
                     exit_code = $1,
                     error = $2,
                     ended_at = NOW(),
                     next_run_at = $3
                 WHERE pid = $4`,
                [exitCode, error, nextRun, pid]
            );
        } finally {
            await adapter.disconnect();
        }
    }

    /**
     * Start the scheduler
     *
     * Polls every minute for due jobs and executes them.
     * Safe to call multiple times (idempotent).
     */
    static startScheduler(): void {
        if (this.schedulerInterval) {
            return; // Already running
        }

        console.info('[Crontab] Starting scheduler');

        // Run immediately, then every minute
        this.tick();
        this.schedulerInterval = setInterval(() => this.tick(), 60_000);
    }

    /**
     * Stop the scheduler
     */
    static stopScheduler(): void {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
            console.info('[Crontab] Scheduler stopped');
        }
    }

    /**
     * Scheduler tick - check and execute due jobs
     */
    private static async tick(): Promise<void> {
        if (this.isRunning) {
            return; // Previous tick still running
        }

        this.isRunning = true;

        try {
            const jobs = await this.getDueJobs();

            for (const job of jobs) {
                // Execute each job (don't await - run in parallel)
                this.executeJob(job).catch(err => {
                    console.error(`[Crontab] Job ${job.pid} failed:`, err);
                });
            }
        } catch (error) {
            console.error('[Crontab] Scheduler tick failed:', error);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Execute a cron job
     */
    private static async executeJob(job: {
        pid: number;
        tenant: string;
        dbType: string;
        dbName: string;
        nsName: string;
        uid: string;
        access: string;
        command: string;
    }): Promise<void> {
        let exitCode = 0;
        let error: string | null = null;

        try {
            // Dynamic import to avoid circular dependency
            const { executeLine } = await import('@src/lib/tty/executor.js');
            const { PassThrough } = await import('node:stream');

            // Create a minimal session for execution
            const session = {
                id: `cron-${job.pid}`,
                state: 'AUTHENTICATED' as const,
                username: 'cron',
                tenant: job.tenant,
                cwd: '/',
                env: {
                    USER: 'cron',
                    TENANT: job.tenant,
                    HOME: '/',
                    SHELL: '/bin/monksh',
                },
                history: [],
                historyIndex: -1,
                inputBuffer: '',
                cursorPosition: 0,
                pid: null,
                systemInit: {
                    tenant: job.tenant,
                    dbType: job.dbType as 'postgresql' | 'sqlite',
                    dbName: job.dbName,
                    nsName: job.nsName,
                    userId: job.uid,
                    username: 'cron',
                    access: job.access,
                    isSudo: job.access === 'root',
                    accessRead: [],
                    accessEdit: [],
                    accessFull: [],
                },
                registrationData: null,
                foregroundIO: null,
            };

            // Create I/O streams (output discarded for now)
            const io = {
                stdin: new PassThrough(),
                stdout: new PassThrough(),
                stderr: new PassThrough(),
            };
            io.stdin.end();

            // Capture output for logging/debugging
            let stdout = '';
            let stderr = '';
            io.stdout.on('data', chunk => { stdout += chunk.toString(); });
            io.stderr.on('data', chunk => { stderr += chunk.toString(); });

            // Execute the command
            exitCode = await executeLine(session as any, job.command, io as any, {
                addToHistory: false,
                useTransaction: true,
            });

            if (exitCode !== 0 && stderr) {
                error = stderr.slice(0, 1000); // Truncate error message
            }

        } catch (err) {
            exitCode = 1;
            error = err instanceof Error ? err.message : String(err);
        }

        // Mark job complete and schedule next run
        await this.completeJob(job.pid, exitCode, error);
    }
}
