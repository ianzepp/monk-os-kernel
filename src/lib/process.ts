/**
 * Process Management
 *
 * Server-wide background job system modeled after Linux /proc.
 * Processes are tracked in the public schema and execute with
 * inherited tenant/user context.
 */

import { System, type SystemInit } from '@src/lib/system.js';
import { runTransaction } from '@src/lib/transaction.js';
import { createAdapter } from '@src/lib/database/index.js';
import type { DatabaseAdapter } from '@src/lib/database/adapter.js';
import { PassThrough } from 'node:stream';

/**
 * Process types
 */
export type ProcessType = 'command' | 'script' | 'cron' | 'daemon';

/**
 * Process state (modeled after Linux)
 * R = Running
 * S = Sleeping (waiting)
 * Z = Zombie (terminated, awaiting cleanup)
 * T = Stopped (paused)
 * X = Dead (terminated)
 */
export type ProcessState = 'R' | 'S' | 'Z' | 'T' | 'X';

/**
 * Process record from database
 */
export interface ProcessRecord {
    // Identity
    pid: number;
    ppid?: number;

    // Connection context
    tenant: string;
    db_type: string;
    db_name: string;
    ns_name: string;

    // Ownership
    uid: string;
    access: string;

    // State
    state: ProcessState;
    exit_code?: number;

    // Command
    comm: string;
    cmdline: string[];
    cwd: string;
    environ?: Record<string, string>;

    // Timing
    created_at: Date;
    started_at?: Date;
    ended_at?: Date;

    // I/O
    stdin?: string;
    stdout?: string;
    stderr?: string;

    // Extensions
    type: ProcessType;
    cron_expr?: string;
    next_run_at?: Date;
    error?: string;
}

/**
 * Options for spawning a process
 */
export interface SpawnOptions {
    type: ProcessType;
    comm: string;
    cmdline: string[];
    cwd?: string;
    environ?: Record<string, string>;
    ppid?: number;
    cronExpr?: string;
}

/**
 * Process I/O streams
 */
export interface ProcessIO {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    /** Abort signal for cancellation */
    signal: AbortSignal;
}

/**
 * Process handler function signature
 */
export type ProcessHandler = (
    system: System,
    cmdline: string[],
    io: ProcessIO
) => Promise<number>;

/**
 * In-memory tracking of running processes for cancellation
 */
interface RunningProcess {
    pid: number;
    abortController: AbortController;
    promise: Promise<void>;
}

const runningProcesses = new Map<number, RunningProcess>();

/**
 * Get the public schema adapter for process table operations
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
 * Register a daemon process (like a shell session)
 *
 * Creates a process record without a handler. The caller is responsible
 * for managing the process lifecycle and calling terminateProcess when done.
 */
export async function registerDaemon(
    init: SystemInit,
    options: Omit<SpawnOptions, 'type'>
): Promise<number> {
    const adapter = await getPublicAdapter();

    try {
        await adapter.beginTransaction();

        const result = await adapter.query<{ pid: number }>(
            `INSERT INTO processes (
                tenant, db_type, db_name, ns_name,
                uid, access,
                state,
                comm, cmdline, cwd, environ,
                type,
                started_at,
                ppid
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6,
                'R',
                $7, $8, $9, $10,
                'daemon',
                now(),
                $11
            ) RETURNING pid`,
            [
                init.tenant,
                init.dbType,
                init.dbName,
                init.nsName,
                init.userId,
                init.access,
                options.comm,
                options.cmdline,
                options.cwd || '/',
                options.environ ? JSON.stringify(options.environ) : null,
                options.ppid || null,
            ]
        );

        await adapter.commit();
        return result.rows[0].pid;

    } catch (error) {
        await adapter.rollback();
        throw error;
    } finally {
        await adapter.disconnect();
    }
}

/**
 * Terminate a daemon process
 *
 * Marks the process as dead with the given exit code.
 */
export async function terminateDaemon(
    pid: number,
    exitCode: number = 0
): Promise<void> {
    const adapter = await getPublicAdapter();

    try {
        await adapter.query(
            `UPDATE processes
             SET state = 'X', exit_code = $1, ended_at = now()
             WHERE pid = $2 AND type = 'daemon'`,
            [exitCode, pid]
        );
    } finally {
        await adapter.disconnect();
    }
}

/**
 * Spawn a new process
 *
 * Creates a process record and starts execution in the background.
 * Returns immediately with the PID.
 */
export async function spawnProcess(
    init: SystemInit,
    options: SpawnOptions,
    handler: ProcessHandler
): Promise<number> {
    const adapter = await getPublicAdapter();

    try {
        await adapter.beginTransaction();

        // Insert process record
        const result = await adapter.query<{ pid: number }>(
            `INSERT INTO processes (
                tenant, db_type, db_name, ns_name,
                uid, access,
                state,
                comm, cmdline, cwd, environ,
                type, cron_expr,
                stdout, stderr,
                ppid
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6,
                'R',
                $7, $8, $9, $10,
                $11, $12,
                $13, $14,
                $15
            ) RETURNING pid`,
            [
                init.tenant,
                init.dbType,
                init.dbName,
                init.nsName,
                init.userId,
                init.access,
                options.comm,
                options.cmdline,
                options.cwd || '/',
                options.environ ? JSON.stringify(options.environ) : null,
                options.type,
                options.cronExpr || null,
                null, // stdout path set after execution
                null, // stderr path set after execution
                options.ppid || null,
            ]
        );

        await adapter.commit();

        const pid = result.rows[0].pid;

        // Start process execution in background
        executeProcess(pid, init, options, handler);

        return pid;

    } catch (error) {
        await adapter.rollback();
        throw error;
    } finally {
        await adapter.disconnect();
    }
}

/**
 * Execute a process (called internally after spawn)
 */
async function executeProcess(
    pid: number,
    init: SystemInit,
    options: SpawnOptions,
    handler: ProcessHandler
): Promise<void> {
    const abortController = new AbortController();

    const processPromise = (async () => {
        const adapter = await getPublicAdapter();

        try {
            // Update started_at
            await adapter.query(
                `UPDATE processes SET started_at = now() WHERE pid = $1`,
                [pid]
            );
            await adapter.disconnect();

            // Create I/O streams
            const io: ProcessIO = {
                stdin: new PassThrough(),
                stdout: new PassThrough(),
                stderr: new PassThrough(),
                signal: abortController.signal,
            };

            // Close stdin immediately (no interactive input)
            io.stdin.end();

            // Collect output for storage
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            io.stdout.on('data', (chunk) => {
                stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            io.stderr.on('data', (chunk) => {
                stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            let exitCode = 0;
            let error: string | null = null;

            try {
                // Run the handler within a transaction
                await runTransaction(init, async (system) => {
                    // Check for abort
                    if (abortController.signal.aborted) {
                        throw new Error('Process killed');
                    }

                    exitCode = await handler(system, options.cmdline, io);

                    // Store stdout/stderr in virtual filesystem
                    const stdout = Buffer.concat(stdoutChunks).toString();
                    const stderr = Buffer.concat(stderrChunks).toString();

                    const procDir = `/tmp/.proc/${pid}`;

                    if (stdout || stderr) {
                        await ensureDir(system, '/tmp/.proc');
                        await ensureDir(system, procDir);
                    }

                    if (stdout) {
                        await system.fs.write(`${procDir}/stdout`, stdout);
                    }

                    if (stderr) {
                        await system.fs.write(`${procDir}/stderr`, stderr);
                    }
                });
            } catch (err) {
                exitCode = 1;
                error = err instanceof Error ? err.message : String(err);

                if (abortController.signal.aborted) {
                    error = 'Process killed';
                }
            }

            // Update final state
            const finalAdapter = await getPublicAdapter();
            try {
                const state: ProcessState = abortController.signal.aborted ? 'Z' :
                                            exitCode === 0 ? 'X' : 'Z';

                await finalAdapter.query(
                    `UPDATE processes
                     SET state = $1, exit_code = $2, error = $3, ended_at = now(),
                         stdout = $4, stderr = $5
                     WHERE pid = $6`,
                    [
                        state,
                        exitCode,
                        error,
                        `/tmp/.proc/${pid}/stdout`,
                        `/tmp/.proc/${pid}/stderr`,
                        pid,
                    ]
                );
            } finally {
                await finalAdapter.disconnect();
            }

        } catch (err) {
            // Fatal error - update state
            const errorAdapter = await getPublicAdapter();
            try {
                await errorAdapter.query(
                    `UPDATE processes SET state = 'Z', error = $1, ended_at = now() WHERE pid = $2`,
                    [err instanceof Error ? err.message : String(err), pid]
                );
            } finally {
                await errorAdapter.disconnect();
            }
        } finally {
            // Remove from running processes
            runningProcesses.delete(pid);
        }
    })();

    // Track running process
    runningProcesses.set(pid, {
        pid,
        abortController,
        promise: processPromise,
    });
}

/**
 * Ensure a directory exists
 */
async function ensureDir(system: System, path: string): Promise<void> {
    try {
        if (!await system.fs.exists(path)) {
            await system.fs.mkdir(path);
        }
    } catch {
        // Ignore - directory may already exist
    }
}

/**
 * List processes for a tenant
 */
export async function listProcesses(
    tenantName: string,
    filter?: { state?: ProcessState; type?: ProcessType }
): Promise<ProcessRecord[]> {
    const adapter = await getPublicAdapter();

    try {
        let query = `SELECT * FROM processes WHERE tenant = $1`;
        const params: any[] = [tenantName];

        if (filter?.state) {
            params.push(filter.state);
            query += ` AND state = $${params.length}`;
        }

        if (filter?.type) {
            params.push(filter.type);
            query += ` AND type = $${params.length}`;
        }

        query += ' ORDER BY created_at DESC';

        const results = await adapter.query<ProcessRecord>(query, params);

        // Parse cmdline and environ JSON
        return results.rows.map((r) => ({
            ...r,
            cmdline: Array.isArray(r.cmdline) ? r.cmdline :
                     typeof r.cmdline === 'string' ? JSON.parse(r.cmdline) : [],
            environ: r.environ ?
                     (typeof r.environ === 'string' ? JSON.parse(r.environ) : r.environ) :
                     undefined,
        }));

    } finally {
        await adapter.disconnect();
    }
}

/**
 * Get a process by PID
 */
export async function getProcess(
    tenantName: string,
    pid: number
): Promise<ProcessRecord | null> {
    const adapter = await getPublicAdapter();

    try {
        const results = await adapter.query<ProcessRecord>(
            `SELECT * FROM processes WHERE tenant = $1 AND pid = $2`,
            [tenantName, pid]
        );

        if (results.rows.length === 0) return null;

        const r = results.rows[0];
        return {
            ...r,
            cmdline: Array.isArray(r.cmdline) ? r.cmdline :
                     typeof r.cmdline === 'string' ? JSON.parse(r.cmdline) : [],
            environ: r.environ ?
                     (typeof r.environ === 'string' ? JSON.parse(r.environ) : r.environ) :
                     undefined,
        };

    } finally {
        await adapter.disconnect();
    }
}

/**
 * Kill a running process
 */
export async function killProcess(
    tenantName: string,
    pid: number
): Promise<boolean> {
    // First, find the process
    const proc = await getProcess(tenantName, pid);
    if (!proc) return false;

    // Check if it's actually running
    if (proc.state !== 'R' && proc.state !== 'S') {
        return false;
    }

    // Try to abort if in memory
    const running = runningProcesses.get(pid);
    if (running) {
        running.abortController.abort();
        return true;
    }

    // Process might be running on another server instance
    // Just update the database state to Zombie
    const adapter = await getPublicAdapter();
    try {
        await adapter.query(
            `UPDATE processes SET state = 'Z', error = 'Killed', ended_at = now() WHERE pid = $1`,
            [pid]
        );
        return true;
    } finally {
        await adapter.disconnect();
    }
}

/**
 * Clean up dead processes (state = X or Z with ended_at older than threshold)
 */
export async function cleanupProcesses(
    olderThanDays: number = 7
): Promise<number> {
    const adapter = await getPublicAdapter();

    try {
        const result = await adapter.query<{ count: number }>(
            `WITH deleted AS (
                DELETE FROM processes
                WHERE state IN ('X', 'Z')
                AND ended_at < now() - interval '${olderThanDays} days'
                RETURNING 1
            )
            SELECT count(*)::int as count FROM deleted`
        );

        return result.rows[0]?.count || 0;

    } finally {
        await adapter.disconnect();
    }
}
