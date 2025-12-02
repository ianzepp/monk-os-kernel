/**
 * Kernel
 *
 * The central coordinator for Monk OS.
 * Manages processes, VFS, network, and message routing.
 */

import type { HAL } from '@src/hal/index.js';
import type { VFS } from '@src/vfs/index.js';
import type {
    Process,
    SpawnOpts,
    ExitStatus,
    SyscallRequest,
    SignalMessage,
    KernelMessage,
    BootEnv,
} from '@src/kernel/types.js';
import { SIGTERM, SIGKILL, TERM_GRACE_MS } from '@src/kernel/types.js';
import { ProcessTable } from '@src/kernel/process-table.js';
import { MAX_HANDLES, STREAM_HIGH_WATER, STREAM_LOW_WATER, STREAM_STALL_TIMEOUT } from '@src/kernel/types.js';
import type { Handle } from '@src/kernel/handle.js';
import { FileHandleAdapter, SocketHandleAdapter, PipeHandleAdapter, PortHandleAdapter, ChannelHandleAdapter, ProcessIOHandle, PortSourceAdapter } from '@src/kernel/handle.js';
import {
    SyscallDispatcher,
    createFileSyscalls,
    createMiscSyscalls,
    createNetworkSyscalls,
    createChannelSyscalls,
} from '@src/kernel/syscalls.js';
import type { Channel, ChannelOpts } from '@src/hal/index.js';
import { ESRCH, ECHILD, ProcessExited, EBADF, EPERM, EINVAL, EMFILE, ETIMEDOUT } from '@src/kernel/errors.js';
import type { Port } from '@src/kernel/resource.js';
import type { WatchEvent } from '@src/vfs/model.js';
import { ListenerPort, WatchPort, UdpPort, PubsubPort, matchTopic, PipeBuffer } from '@src/kernel/resource.js';
import type { ProcessPortMessage } from '@src/kernel/syscalls.js';
import { respond } from '@src/message.js';
import type { Response, Message } from '@src/message.js';
import type { ServiceDef, IOSource, IOTarget } from '@src/kernel/services.js';
import { loadMounts } from '@src/kernel/mounts.js';
import { copyRomToVfs } from '@src/kernel/boot.js';
import { VFSLoader } from '@src/kernel/loader.js';
import { PoolManager, type LeasedWorker } from '@src/kernel/pool.js';
import {
    assertString,
    assertNonNegativeInt,
    assertPositiveInt,
    assertObject,
    optionalString,
    optionalPositiveInt,
} from '@src/kernel/validate.js';

/**
 * Debug logging - enabled via DEBUG=1 environment variable
 */
const DEBUG = process.env.DEBUG === '1';
function debug(category: string, ...args: unknown[]): void {
    if (DEBUG) {
        console.log(`[kernel:${category}]`, ...args);
    }
}

/**
 * Console device path
 */
const CONSOLE_PATH = '/dev/console';

/**
 * Format error message for consistent logging.
 */
function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Kernel class
 */
export class Kernel {
    // ========================================================================
    // State
    // ========================================================================

    // Core dependencies
    private hal: HAL;
    private vfs: VFS;
    private processes: ProcessTable;
    private syscalls: SyscallDispatcher;

    // Unified handle table
    private handles: Map<string, Handle> = new Map();
    private handleRefs: Map<string, number> = new Map();

    // Pubsub routing (needed for topic-based message dispatch)
    private pubsubPorts: Set<PubsubPort> = new Set();

    private waiters: Map<string, ((status: ExitStatus) => void)[]> = new Map();
    private booted = false;

    // Service management
    private services: Map<string, ServiceDef> = new Map(); // name -> def
    private activationPorts: Map<string, Port> = new Map(); // service name -> port
    private activationAborts: Map<string, AbortController> = new Map(); // service name -> abort

    // VFS module loader for dynamic script execution
    private loader: VFSLoader;

    // Worker pool manager
    private poolManager: PoolManager;

    // Leased workers by process: processId -> workerUUID -> LeasedWorker
    private leasedWorkers: Map<string, Map<string, LeasedWorker>> = new Map();

    constructor(hal: HAL, vfs: VFS) {
        this.hal = hal;
        this.vfs = vfs;
        this.processes = new ProcessTable();
        this.syscalls = new SyscallDispatcher();
        this.loader = new VFSLoader(vfs, hal);
        this.poolManager = new PoolManager(hal);

        this.registerSyscalls();
    }

    /**
     * Register all syscall handlers.
     */
    private registerSyscalls(): void {
        // Helper to wrap async functions as async generators
        const wrapSyscall = <T>(fn: (proc: Process, ...args: unknown[]) => Promise<T> | T) => {
            return async function* (proc: Process, ...args: unknown[]): AsyncIterable<Response> {
                const result = await fn(proc, ...args);
                yield respond.ok(result);
            };
        };

        // Process syscalls
        this.syscalls.registerAll({
            spawn: wrapSyscall((proc, entry, opts) => {
                assertString(entry, 'entry');
                return this.spawn(proc, entry, opts as SpawnOpts);
            }),
            exit: wrapSyscall((proc, code) => {
                assertNonNegativeInt(code, 'code');
                return this.exit(proc, code);
            }),
            kill: wrapSyscall((proc, pid, signal) => {
                assertPositiveInt(pid, 'pid');
                const sig = optionalPositiveInt(signal, 'signal');
                return this.kill(proc, pid, sig);
            }),
            wait: wrapSyscall((proc, pid, timeout) => {
                assertPositiveInt(pid, 'pid');
                const ms = optionalPositiveInt(timeout, 'timeout');
                return this.wait(proc, pid, ms);
            }),
            getpid: wrapSyscall((proc) => this.getpid(proc)),
            getppid: wrapSyscall((proc) => this.getppid(proc)),
        });

        // File syscalls
        this.syscalls.registerAll(
            createFileSyscalls(
                this.vfs,
                this.hal,
                (proc, fd) => this.getHandle(proc, fd),
                (proc, path, flags) => this.openFile(proc, path, flags),
                (proc, fd) => this.closeHandle(proc, fd)
            )
        );

        // Network syscalls
        this.syscalls.registerAll(
            createNetworkSyscalls(
                this.hal,
                (proc, host, port) => this.connectTcp(proc, host, port),
                (proc, type, opts) => this.createPort(proc, type, opts),
                (proc, h) => this.getPortFromHandle(proc, h),
                (proc, h) => this.recvPort(proc, h),
                (proc, h) => this.closeHandle(proc, h)
            )
        );

        // Misc syscalls
        this.syscalls.registerAll(createMiscSyscalls(this.vfs));

        // Channel syscalls
        this.syscalls.registerAll(
            createChannelSyscalls(
                this.hal,
                (proc, proto, url, opts) => this.openChannel(proc, proto, url, opts),
                (proc, ch) => this.getChannelFromHandle(proc, ch),
                (proc, ch) => this.closeHandle(proc, ch)
            )
        );

        // Pipe syscall
        this.syscalls.register('pipe', wrapSyscall((proc) => this.createPipe(proc)));

        // Redirect syscalls
        this.syscalls.register('handle:redirect', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertNonNegativeInt(args['target'], 'target');
            assertNonNegativeInt(args['source'], 'source');
            return this.redirectHandle(proc, args['target'] as number, args['source'] as number);
        }));
        this.syscalls.register('handle:restore', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertNonNegativeInt(args['target'], 'target');
            assertString(args['saved'], 'saved');
            return this.restoreHandle(proc, args['target'] as number, args['saved'] as string);
        }));

        // Worker pool syscalls
        this.syscalls.register('pool:lease', wrapSyscall((proc, pool) => {
            const poolName = optionalString(pool, 'pool');
            return this.leaseWorker(proc, poolName);
        }));
        this.syscalls.register('worker:load', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertString(args['workerId'], 'workerId');
            assertString(args['path'], 'path');
            return this.workerLoad(proc, args['workerId'] as string, args['path'] as string);
        }));
        this.syscalls.register('worker:send', wrapSyscall((proc, args) => {
            assertObject(args, 'args');
            assertString(args['workerId'], 'workerId');
            return this.workerSend(proc, args['workerId'] as string, args['msg']);
        }));
        this.syscalls.register('worker:recv', wrapSyscall((proc, workerId) => {
            assertString(workerId, 'workerId');
            return this.workerRecv(proc, workerId);
        }));
        this.syscalls.register('worker:release', wrapSyscall((proc, workerId) => {
            assertString(workerId, 'workerId');
            return this.workerRelease(proc, workerId);
        }));
        const poolManager = this.poolManager;
        this.syscalls.register('pool:stats', async function* (): AsyncIterable<Response> {
            yield respond.ok(poolManager.stats());
        });

        // Unified handle syscalls (Phase 2)
        this.syscalls.register('handle:send', async function* (
            this: Kernel,
            proc: Process,
            h: unknown,
            msg: unknown
        ): AsyncIterable<Response> {
            if (typeof h !== 'number') {
                yield respond.error('EINVAL', 'handle must be a number');
                return;
            }

            const handle = this.getHandle(proc, h);
            if (!handle) {
                yield respond.error('EBADF', `Bad handle: ${h}`);
                return;
            }

            yield* handle.send(msg as import('@src/message.js').Message);
        }.bind(this));

        this.syscalls.register('handle:close', wrapSyscall((proc, h) =>
            this.closeHandle(proc, h as number)
        ));

        // Activation syscall - returns the activation message for service handlers
        this.syscalls.register('activation:get', wrapSyscall((proc) => proc.activationMessage ?? null));
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Boot the kernel.
     *
     * Initializes VFS, loads services, and starts the init process.
     */
    async boot(env: BootEnv): Promise<void> {
        if (this.booted) {
            throw new Error('Kernel already booted');
        }

        // Initialize VFS (creates root folder, /dev devices)
        await this.vfs.init();

        // Create standard directories
        await this.vfs.mkdir('/var', 'kernel', { recursive: true });
        await this.vfs.mkdir('/var/log', 'kernel', { recursive: true });

        // Copy ROM into VFS (Phase 0 → Phase 1 transition)
        // Reads ./rom/ and creates real VFS entities with UUIDs and ACLs
        await copyRomToVfs({ vfs: this.vfs }, './rom');

        // Load and apply mounts from /etc/mounts.json
        await loadMounts({ vfs: this.vfs, hal: this.hal, loader: this.loader });

        // Load worker pool configuration from /etc/pools.json
        await this.poolManager.loadConfig(this.vfs);

        // Load and activate services
        await this.loadServices();

        // Create init process
        const init = this.createProcess({
            cmd: env.initPath,
            env: env.env,
            args: env.initArgs,
        });

        // Setup stdio for init - open /dev/console
        await this.setupInitStdio(init);

        // Start init worker
        init.worker = await this.spawnWorker(init, env.initPath);
        init.state = 'running';

        // Register init
        this.processes.register(init);

        this.booted = true;
    }

    /**
     * Shutdown the kernel.
     *
     * Sends SIGTERM to all processes, waits for grace period,
     * then sends SIGKILL to remaining processes.
     */
    async shutdown(): Promise<void> {
        if (!this.booted) return;

        // Count running processes (excluding zombies)
        let runningCount = 0;
        const init = this.processes.getInit();
        for (const proc of this.processes.all()) {
            if (proc !== init && proc.state === 'running') {
                this.deliverSignal(proc, SIGTERM);
                runningCount++;
            }
        }

        // Only wait for grace period if there are running processes to terminate
        if (runningCount > 0) {
            await new Promise(resolve => setTimeout(resolve, TERM_GRACE_MS));
        }

        // Force kill ALL remaining processes including init
        for (const proc of this.processes.all()) {
            if (proc.state === 'running' || proc.state === 'starting') {
                this.forceExit(proc, 128 + SIGKILL);
            }
        }

        // Stop all service activation loops
        for (const abort of this.activationAborts.values()) {
            abort.abort();
        }

        // Close all activation ports
        for (const port of this.activationPorts.values()) {
            await port.close().catch((err) => {
                debug('cleanup', `activation port close failed: ${(err as Error).message}`);
            });
        }

        // Clear process table and all maps
        this.processes.clear();
        this.handles.clear();
        this.handleRefs.clear();
        this.waiters.clear();
        this.services.clear();
        this.activationPorts.clear();
        this.activationAborts.clear();

        // Shutdown worker pools
        this.poolManager.shutdown();
        this.leasedWorkers.clear();

        this.booted = false;
    }

    // ========================================================================
    // Process Management
    // ========================================================================

    /**
     * Create a new Process object with common defaults.
     *
     * @param opts - Process creation options
     * @returns New Process object in 'starting' state
     */
    private createProcess(opts: {
        parent?: Process;
        cmd: string;
        cwd?: string;
        env?: Record<string, string>;
        args?: string[];
    }): Process {
        return {
            id: this.hal.entropy.uuid(),
            parent: opts.parent?.id ?? '',
            worker: null as unknown as Worker,
            state: 'starting',
            cmd: opts.cmd,
            cwd: opts.cwd ?? opts.parent?.cwd ?? '/',
            env: opts.parent ? { ...opts.parent.env, ...opts.env } : (opts.env ?? {}),
            args: opts.args ?? [opts.cmd],
            handles: new Map(),
            nextHandle: 3,
            children: new Map(),
            nextPid: 1,
            activeStreams: new Map(),
            streamPingHandlers: new Map(),
        };
    }

    /**
     * Spawn a child process.
     */
    private async spawn(parent: Process, entry: string, opts?: SpawnOpts): Promise<number> {
        const proc = this.createProcess({
            parent,
            cmd: entry,
            cwd: opts?.cwd,
            env: opts?.env,
            args: opts?.args,
        });

        // Setup stdio
        this.setupStdio(proc, parent, opts);

        // Create worker
        proc.worker = await this.spawnWorker(proc, entry);
        proc.state = 'running';

        // Register in process table
        this.processes.register(proc);

        // Assign PID in parent's namespace
        const pid = parent.nextPid++;
        parent.children.set(pid, proc.id);

        return pid;
    }

    /**
     * Exit the current process.
     */
    private async exit(proc: Process, code: number): Promise<never> {
        proc.exitCode = code;
        proc.state = 'zombie';

        // Close all handles
        for (const [h] of proc.handles) {
            try {
                await this.closeHandle(proc, h);
            } catch (err) {
                debug('cleanup', `handle ${h} close failed: ${(err as Error).message}`);
            }
        }

        // Terminate worker
        proc.worker.terminate();

        // Reparent children to init
        this.processes.reparentOrphans(proc.id);

        // Notify waiters
        this.notifyWaiters(proc);

        throw new ProcessExited(code);
    }

    /**
     * Send signal to a process.
     */
    private kill(caller: Process, targetPid: number, signal: number = SIGTERM): void {
        const target = this.processes.resolvePid(caller, targetPid);
        if (!target) {
            throw new ESRCH(`No such process: ${targetPid}`);
        }

        // Check permission (can only signal own children or self)
        if (target.parent !== caller.id && target.id !== caller.id) {
            // Check if init (init can signal anyone)
            const init = this.processes.getInit();
            if (caller !== init) {
                throw new EPERM(`Cannot signal process ${targetPid}`);
            }
        }

        if (signal === SIGKILL) {
            this.forceExit(target, 128 + SIGKILL);
        } else if (signal === SIGTERM) {
            this.deliverSignal(target, SIGTERM);

            // Schedule force kill after grace period
            setTimeout(() => {
                if (target.state === 'running') {
                    this.forceExit(target, 128 + SIGTERM);
                }
            }, TERM_GRACE_MS);
        }
    }

    /**
     * Wait for a child process to exit.
     *
     * @param caller - The calling process
     * @param pid - Process ID to wait for
     * @param timeout - Optional timeout in milliseconds. If exceeded, throws ETIMEDOUT.
     */
    private async wait(caller: Process, pid: number, timeout?: number): Promise<ExitStatus> {
        const target = this.processes.resolvePid(caller, pid);
        if (!target) {
            throw new ESRCH(`No such process: ${pid}`);
        }

        if (target.parent !== caller.id) {
            throw new ECHILD(`Process ${pid} is not a child`);
        }

        // If already zombie, return immediately
        if (target.state === 'zombie') {
            const status: ExitStatus = { pid, code: target.exitCode ?? 0 };

            // Reap the zombie
            this.reapZombie(caller, pid, target);

            return status;
        }

        // Create the wait promise
        const waitPromise = new Promise<ExitStatus>((resolve) => {
            const waiters = this.waiters.get(target.id) ?? [];
            waiters.push((status) => {
                // Reap the zombie
                this.reapZombie(caller, pid, target);
                resolve({ ...status, pid });
            });
            this.waiters.set(target.id, waiters);
        });

        // If no timeout, wait indefinitely
        if (timeout === undefined || timeout <= 0) {
            return waitPromise;
        }

        // Race wait against timeout
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
                reject(new ETIMEDOUT(`wait() timed out after ${timeout}ms`));
            }, timeout);
        });

        return Promise.race([waitPromise, timeoutPromise]);
    }

    /**
     * Get current process ID.
     */
    private getpid(proc: Process): number {
        // Find our PID in parent's namespace
        const parent = this.processes.get(proc.parent);
        if (!parent) {
            return 1; // init
        }

        for (const [pid, id] of parent.children) {
            if (id === proc.id) {
                return pid;
            }
        }

        return 0; // shouldn't happen
    }

    /**
     * Get parent process ID.
     */
    private getppid(proc: Process): number {
        if (!proc.parent) {
            return 0; // init has no parent
        }

        const parent = this.processes.get(proc.parent);
        if (!parent) {
            return 1; // reparented to init
        }

        // Find parent's PID in grandparent's namespace
        const grandparent = this.processes.get(parent.parent);
        if (!grandparent) {
            return 1;
        }

        for (const [pid, id] of grandparent.children) {
            if (id === parent.id) {
                return pid;
            }
        }

        return 1;
    }

    // ========================================================================
    // Worker & Message Handling
    // ========================================================================

    /**
     * Spawn a worker for a process.
     *
     * All paths starting with / are VFS paths and go through the VFS loader.
     * ROM contents (./src/rom/) are copied into VFS at boot time.
     */
    private async spawnWorker(proc: Process, entry: string): Promise<Worker> {
        // All paths go through VFS loader
        const bundle = await this.loader.assembleBundle(entry);
        const workerUrl = this.loader.createBlobURL(bundle);

        const worker = new Worker(workerUrl, {
            type: 'module',
            env: proc.env,
        });

        // Revoke blob URL after worker loads (it's already loaded the code)
        setTimeout(() => this.loader.revokeBlobURL(workerUrl), 1000);

        // Wire up syscall handling
        worker.onmessage = (event: MessageEvent<KernelMessage>) => {
            this.handleMessage(proc, event.data);
        };

        worker.onerror = (error) => {
            const msg = `Process ${proc.cmd} error: ${error.message}\n`;
            this.hal.console.error(new TextEncoder().encode(msg));
            this.forceExit(proc, 1);
        };

        return worker;
    }

    /**
     * Handle message from process.
     */
    private async handleMessage(proc: Process, msg: KernelMessage): Promise<void> {
        switch (msg.type) {
            case 'syscall':
                await this.handleSyscall(proc, msg as SyscallRequest);
                break;
            case 'stream_ping':
                this.handleStreamPing(proc, msg.id, msg.processed);
                break;
            case 'stream_cancel':
                this.handleStreamCancel(proc, msg.id);
                break;
        }
    }

    /**
     * Handle syscall request with streaming response and backpressure.
     */
    private async handleSyscall(proc: Process, request: SyscallRequest): Promise<void> {
        debug('syscall', `${proc.cmd}: ${request.name}(${JSON.stringify(request.args).slice(0, 100)})`);

        // Create abort controller for this stream
        const abort = new AbortController();
        proc.activeStreams.set(request.id, abort);

        // Backpressure state
        let itemsSent = 0;
        let itemsAcked = 0;
        let lastPingTime = Date.now();
        let resumeResolve: (() => void) | null = null;

        // Create ping handler that updates acked count and may resume
        proc.streamPingHandlers.set(request.id, (processed: number) => {
            itemsAcked = processed;
            lastPingTime = Date.now();
            // Resume if we were paused and gap is now acceptable
            if (resumeResolve && (itemsSent - itemsAcked) <= STREAM_LOW_WATER) {
                resumeResolve();
                resumeResolve = null;
            }
        });

        try {
            const iterable = this.syscalls.dispatch(proc, request.name, request.args);

            for await (const response of iterable) {
                // Check if stream was cancelled
                if (abort.signal.aborted) {
                    break;
                }

                // Check for stall (no ping for too long)
                // Only check stall if we've sent items - consumers can't ping for items they haven't received
                // This prevents false timeouts when the producer (e.g., pipe) is slow to produce the first item
                if (itemsSent > 0 && Date.now() - lastPingTime >= STREAM_STALL_TIMEOUT) {
                    proc.worker.postMessage({
                        type: 'response',
                        id: request.id,
                        result: { op: 'error', data: { code: 'ETIMEDOUT', message: 'Stream consumer unresponsive' } },
                    });
                    debug('syscall', `${proc.cmd}: ${request.name} -> timeout (stall)`);
                    return;
                }

                // Send response to process
                proc.worker.postMessage({
                    type: 'response',
                    id: request.id,
                    result: response,
                });

                // Terminal ops end the stream
                if (response.op === 'ok' || response.op === 'done' || response.op === 'error' || response.op === 'redirect') {
                    debug('syscall', `${proc.cmd}: ${request.name} -> ${response.op}`);
                    return;
                }

                // Track non-terminal items for backpressure
                itemsSent++;

                // Reset ping timer on first item - consumer needs time to receive and process before pinging
                if (itemsSent === 1) {
                    lastPingTime = Date.now();
                }

                // Backpressure: pause if too far ahead of consumer
                const gap = itemsSent - itemsAcked;
                if (gap >= STREAM_HIGH_WATER) {
                    debug('syscall', `${proc.cmd}: ${request.name} -> backpressure (gap=${gap})`);
                    await new Promise<void>(resolve => {
                        resumeResolve = resolve;
                        // Also set a timeout to avoid permanent block
                        setTimeout(() => {
                            if (resumeResolve === resolve) {
                                resolve();
                                resumeResolve = null;
                            }
                        }, STREAM_STALL_TIMEOUT);
                    });
                    // Re-check stall after resume
                    if (Date.now() - lastPingTime >= STREAM_STALL_TIMEOUT) {
                        proc.worker.postMessage({
                            type: 'response',
                            id: request.id,
                            result: { op: 'error', data: { code: 'ETIMEDOUT', message: 'Stream consumer unresponsive' } },
                        });
                        debug('syscall', `${proc.cmd}: ${request.name} -> timeout (backpressure stall)`);
                        return;
                    }
                }
            }
        } catch (error) {
            // Uncaught exceptions become error responses
            const err = error as Error & { code?: string };
            proc.worker.postMessage({
                type: 'response',
                id: request.id,
                result: { op: 'error', data: { code: err.code ?? 'EIO', message: err.message } },
            });
            debug('syscall', `${proc.cmd}: ${request.name} -> error: ${err.code ?? 'EIO'}`);
        } finally {
            // Clean up stream tracking
            proc.activeStreams.delete(request.id);
            proc.streamPingHandlers.delete(request.id);
        }
    }

    /**
     * Handle stream ping (progress report from userspace).
     */
    private handleStreamPing(proc: Process, requestId: string, processed: number): void {
        const handler = proc.streamPingHandlers.get(requestId);
        if (handler) {
            handler(processed);
        }
    }

    /**
     * Handle stream cancel (stop producing, cleanup).
     */
    private handleStreamCancel(proc: Process, requestId: string): void {
        const abort = proc.activeStreams.get(requestId);
        if (abort) {
            abort.abort();
            proc.activeStreams.delete(requestId);
            proc.streamPingHandlers.delete(requestId);
        }
    }

    // ========================================================================
    // Stdio Setup
    // ========================================================================

    /**
     * Setup stdio for init process.
     *
     * Opens /dev/console for stdin, stdout, stderr.
     */
    private async setupInitStdio(init: Process): Promise<void> {
        // Open console for stdin (read-only)
        const stdinVfs = await this.vfs.open(CONSOLE_PATH, { read: true }, 'kernel');
        const stdinAdapter = new FileHandleAdapter(stdinVfs.id, stdinVfs);
        this.handles.set(stdinAdapter.id, stdinAdapter);
        this.handleRefs.set(stdinAdapter.id, 1);
        init.handles.set(0, stdinAdapter.id);

        // Open console for stdout (write-only)
        const stdoutVfs = await this.vfs.open(CONSOLE_PATH, { write: true }, 'kernel');
        const stdoutAdapter = new FileHandleAdapter(stdoutVfs.id, stdoutVfs);
        this.handles.set(stdoutAdapter.id, stdoutAdapter);
        this.handleRefs.set(stdoutAdapter.id, 1);
        init.handles.set(1, stdoutAdapter.id);

        // Open console for stderr (write-only)
        const stderrVfs = await this.vfs.open(CONSOLE_PATH, { write: true }, 'kernel');
        const stderrAdapter = new FileHandleAdapter(stderrVfs.id, stderrVfs);
        this.handles.set(stderrAdapter.id, stderrAdapter);
        this.handleRefs.set(stderrAdapter.id, 1);
        init.handles.set(2, stderrAdapter.id);
    }

    /**
     * Setup stdio for a new process.
     *
     * Inherits file descriptors from parent and increments reference counts.
     */
    private setupStdio(proc: Process, parent: Process, opts?: SpawnOpts): void {
        // Inherit from parent by default
        const stdin = opts?.stdin ?? 0;
        const stdout = opts?.stdout ?? 1;
        const stderr = opts?.stderr ?? 2;

        if (typeof stdin === 'number') {
            const handleId = parent.handles.get(stdin);
            if (handleId) {
                proc.handles.set(0, handleId);
                this.refHandle(handleId);
            }
        }

        if (typeof stdout === 'number') {
            const handleId = parent.handles.get(stdout);
            if (handleId) {
                proc.handles.set(1, handleId);
                this.refHandle(handleId);
            }
        }

        if (typeof stderr === 'number') {
            const handleId = parent.handles.get(stderr);
            if (handleId) {
                proc.handles.set(2, handleId);
                this.refHandle(handleId);
            }
        }

        // TODO: Handle 'pipe' option to create new pipes
    }

    // ========================================================================
    // Process Cleanup
    // ========================================================================

    /**
     * Force exit a process immediately.
     *
     * Unlike graceful exit(), this doesn't await cleanup - but we still
     * release kernel-side resources. The process doesn't get a chance to
     * clean up, but the kernel must not leak handles.
     */
    private forceExit(proc: Process, code: number): void {
        if (proc.state === 'zombie') return;

        proc.exitCode = code;
        proc.state = 'zombie';

        // Terminate worker immediately
        proc.worker.terminate();

        // Abort all active streams
        for (const abort of proc.activeStreams.values()) {
            abort.abort();
        }
        proc.activeStreams.clear();
        proc.streamPingHandlers.clear();

        // Clean up handles with refcounting (fire-and-forget, don't await)
        for (const handleId of proc.handles.values()) {
            this.unrefHandle(handleId);
        }
        proc.handles.clear();

        // Release any leased workers back to pool
        this.releaseProcessWorkers(proc);

        // Reparent children
        this.processes.reparentOrphans(proc.id);

        // Notify waiters
        this.notifyWaiters(proc);
    }

    /**
     * Deliver a signal to a process.
     */
    private deliverSignal(proc: Process, signal: number): void {
        const msg: SignalMessage = {
            type: 'signal',
            signal,
        };
        proc.worker.postMessage(msg);
    }

    /**
     * Notify processes waiting on this process.
     */
    private notifyWaiters(proc: Process): void {
        const waiters = this.waiters.get(proc.id);
        if (!waiters) return;

        const status: ExitStatus = {
            pid: 0, // Will be set by caller
            code: proc.exitCode ?? 0,
        };

        for (const waiter of waiters) {
            waiter(status);
        }

        this.waiters.delete(proc.id);
    }

    /**
     * Reap a zombie process.
     */
    private reapZombie(parent: Process, pid: number, zombie: Process): void {
        // Remove from parent's children
        parent.children.delete(pid);

        // Remove from process table
        this.processes.unregister(zombie.id);
    }

    // ========================================================================
    // Unified Handle Operations
    // ========================================================================

    /**
     * Get a handle by process-local ID.
     */
    getHandle(proc: Process, h: number): Handle | undefined {
        const handleId = proc.handles.get(h);
        if (!handleId) return undefined;
        return this.handles.get(handleId);
    }

    /**
     * Allocate a handle ID and register in process and kernel tables.
     */
    private allocHandle(proc: Process, handle: Handle): number {
        if (proc.handles.size >= MAX_HANDLES) {
            throw new EMFILE('Too many open handles');
        }

        // Register in kernel table
        this.handles.set(handle.id, handle);
        this.handleRefs.set(handle.id, 1);

        // Allocate ID in process
        const h = proc.nextHandle++;
        proc.handles.set(h, handle.id);

        return h;
    }

    /**
     * Increment reference count for a handle.
     */
    private refHandle(handleId: string): void {
        const refs = this.handleRefs.get(handleId) ?? 1;
        this.handleRefs.set(handleId, refs + 1);
    }

    /**
     * Decrement reference count, closing if last ref.
     */
    private unrefHandle(handleId: string): void {
        const refs = (this.handleRefs.get(handleId) ?? 1) - 1;
        if (refs <= 0) {
            const handle = this.handles.get(handleId);
            if (handle) {
                handle.close().catch((err) => {
                    debug('cleanup', `handle ${handleId} close failed: ${(err as Error).message}`);
                });
                this.handles.delete(handleId);
            }
            this.handleRefs.delete(handleId);
        } else {
            this.handleRefs.set(handleId, refs);
        }
    }

    // ========================================================================
    // File Operations (Unified Handle Architecture)
    // ========================================================================

    /**
     * Open a file and allocate handle.
     */
    private async openFile(proc: Process, path: string, flags: import('@src/kernel/types.js').OpenFlags): Promise<number> {
        const vfsHandle = await this.vfs.open(path, flags, proc.id);
        const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);
        return this.allocHandle(proc, adapter);
    }

    /**
     * Connect TCP or Unix socket and allocate handle.
     *
     * For TCP: host is hostname/IP, port is port number
     * For Unix: host is socket path, port is 0
     */
    private async connectTcp(proc: Process, host: string, port: number): Promise<number> {
        const socket = await this.hal.network.connect(host, port);

        const isUnix = port === 0;
        const description = isUnix
            ? `unix:${host}`
            : `tcp:${socket.stat().remoteAddr}:${socket.stat().remotePort}`;
        const adapter = new SocketHandleAdapter(this.hal.entropy.uuid(), socket, description);
        return this.allocHandle(proc, adapter);
    }

    /**
     * Close a handle.
     *
     * Uses reference counting - only closes the underlying resource
     * when the last reference is released.
     */
    private async closeHandle(proc: Process, h: number): Promise<void> {
        const handleId = proc.handles.get(h);
        if (!handleId) {
            throw new EBADF(`Bad file descriptor: ${h}`);
        }

        // Remove handle from process
        proc.handles.delete(h);

        // Decrement refcount (unrefHandle handles cleanup)
        this.unrefHandle(handleId);
    }

    /**
     * Create a pipe and return [readH, writeH].
     *
     * Creates a unidirectional data channel. Data written to writeH
     * can be read from readH. Closing writeH signals EOF to readers.
     */
    private createPipe(proc: Process): [number, number] {
        // Check handle limit (need 2 handles)
        if (proc.handles.size + 2 > MAX_HANDLES) {
            throw new EMFILE('Too many open handles');
        }

        // Create shared buffer
        const buffer = new PipeBuffer();
        const pipeId = this.hal.entropy.uuid();

        // Create read end
        const readAdapter = new PipeHandleAdapter(
            `${pipeId}:read`,
            buffer,
            'read',
            `pipe:${pipeId}:read`
        );
        const readH = this.allocHandle(proc, readAdapter);

        // Create write end
        const writeAdapter = new PipeHandleAdapter(
            `${pipeId}:write`,
            buffer,
            'write',
            `pipe:${pipeId}:write`
        );
        const writeH = this.allocHandle(proc, writeAdapter);

        return [readH, writeH];
    }

    /**
     * Redirect a handle to point to the same resource as another handle.
     *
     * Returns the saved handle ID so it can be restored later.
     * The caller must call restoreHandle to restore the original resource.
     */
    private redirectHandle(proc: Process, targetH: number, sourceH: number): string {
        const sourceHandleId = proc.handles.get(sourceH);
        if (!sourceHandleId) {
            throw new EBADF(`Bad source file descriptor: ${sourceH}`);
        }

        const savedHandleId = proc.handles.get(targetH);
        if (!savedHandleId) {
            throw new EBADF(`Bad target file descriptor: ${targetH}`);
        }

        // Point target to source's handle
        proc.handles.set(targetH, sourceHandleId);

        // Increment refcount on the source handle
        this.refHandle(sourceHandleId);

        return savedHandleId;
    }

    /**
     * Restore a handle to its original resource.
     *
     * This should be called after redirectHandle to restore the original resource.
     */
    private restoreHandle(proc: Process, targetH: number, savedHandleId: string): void {
        const currentHandleId = proc.handles.get(targetH);
        if (!currentHandleId) {
            throw new EBADF(`Bad file descriptor: ${targetH}`);
        }

        // Restore the original handle
        proc.handles.set(targetH, savedHandleId);

        // Decrement refcount on the current handle (it was redirected)
        // Don't close - redirected handles shouldn't be auto-closed here
        // The original handle that opened the resource will close it
        const refs = (this.handleRefs.get(currentHandleId) ?? 1) - 1;
        if (refs <= 0) {
            this.handleRefs.delete(currentHandleId);
        } else {
            this.handleRefs.set(currentHandleId, refs);
        }
    }

    /**
     * Create a port and allocate handle.
     */
    private async createPort(proc: Process, type: string, opts: unknown): Promise<number> {
        let port: Port;

        switch (type) {
            case 'tcp:listen': {
                const listenOpts = opts as { port: number; host?: string; backlog?: number } | undefined;
                if (!listenOpts || typeof listenOpts.port !== 'number') {
                    throw new EINVAL('tcp:listen requires port option');
                }

                const listener = await this.hal.network.listen(listenOpts.port, {
                    hostname: listenOpts.host,
                    backlog: listenOpts.backlog,
                });

                const portId = this.hal.entropy.uuid();
                const addr = listener.addr();
                const description = `tcp:listen:${addr.hostname}:${addr.port}`;
                port = new ListenerPort(portId, listener, description);
                break;
            }

            case 'watch': {
                const watchOpts = opts as { pattern: string } | undefined;
                if (!watchOpts || typeof watchOpts.pattern !== 'string') {
                    throw new EINVAL('watch requires pattern option');
                }

                const portId = this.hal.entropy.uuid();
                const description = `watch:${watchOpts.pattern}`;

                // Create a function that returns the VFS watch iterable
                const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                    return this.vfs.watch(pattern, proc.id);
                };

                port = new WatchPort(portId, watchOpts.pattern, vfsWatch, description);
                break;
            }

            case 'udp': {
                const udpOpts = opts as { bind: number; address?: string } | undefined;
                if (!udpOpts || typeof udpOpts.bind !== 'number') {
                    throw new EINVAL('udp requires bind option');
                }

                const portId = this.hal.entropy.uuid();
                const description = `udp:${udpOpts.address ?? '0.0.0.0'}:${udpOpts.bind}`;
                port = new UdpPort(portId, udpOpts, description);
                break;
            }

            case 'pubsub': {
                const pubsubOpts = opts as { subscribe?: string | string[] } | undefined;
                const patterns = pubsubOpts?.subscribe
                    ? Array.isArray(pubsubOpts.subscribe)
                        ? pubsubOpts.subscribe
                        : [pubsubOpts.subscribe]
                    : [];

                const portId = this.hal.entropy.uuid();
                const description = patterns.length > 0
                    ? `pubsub:${patterns.join(',')}`
                    : 'pubsub:(send-only)';

                // Create publish function that routes through kernel
                const publishFn = (topic: string, data: Uint8Array, sourcePortId: string) => {
                    this.publishPubsub(topic, data, sourcePortId);
                };

                // Create unsubscribe function for cleanup
                const unsubscribeFn = () => {
                    // Look up the port handle by its ID in the kernel handles registry
                    const handle = this.handles.get(portId) as PortHandleAdapter | undefined;
                    if (handle) {
                        const p = handle.getPort() as PubsubPort;
                        this.pubsubPorts.delete(p);
                    }
                };

                const pubsubPort = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);

                // Register in pubsub routing set
                this.pubsubPorts.add(pubsubPort);

                port = pubsubPort;
                break;
            }

            default:
                throw new EINVAL(`unknown port type: ${type}`);
        }

        // Create adapter and allocate handle
        const adapter = new PortHandleAdapter(port.id, port, port.description);
        return this.allocHandle(proc, adapter);
    }

    /**
     * Get port from a handle.
     */
    private getPortFromHandle(proc: Process, h: number): Port | undefined {
        const handle = this.getHandle(proc, h);
        if (!handle || handle.type !== 'port') return undefined;
        return (handle as PortHandleAdapter).getPort();
    }

    /**
     * Receive from port handle, auto-allocating handle for sockets.
     */
    private async recvPort(proc: Process, h: number): Promise<ProcessPortMessage> {
        const port = this.getPortFromHandle(proc, h);
        if (!port) {
            throw new EBADF(`Bad port: ${h}`);
        }

        const msg = await port.recv();

        // If message contains a socket, wrap it and allocate handle
        if (msg.socket) {
            if (proc.handles.size >= MAX_HANDLES) {
                // Can't accept - close the socket and throw
                await msg.socket.close();
                throw new EMFILE('Too many open handles');
            }

            const stat = msg.socket.stat();
            const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
            const adapter = new SocketHandleAdapter(this.hal.entropy.uuid(), msg.socket, description);
            const fd = this.allocHandle(proc, adapter);

            return {
                from: msg.from,
                fd,
                meta: msg.meta,
            };
        }

        // Regular data message
        return {
            from: msg.from,
            data: msg.data,
            meta: msg.meta,
        };
    }

    // =========================================================================
    // Channel Management (Unified Handle Architecture)
    // =========================================================================

    /**
     * Open a channel and allocate handle.
     */
    private async openChannel(
        proc: Process,
        proto: string,
        url: string,
        opts?: ChannelOpts
    ): Promise<number> {
        const channel = await this.hal.channel.open(proto, url, opts);
        const adapter = new ChannelHandleAdapter(channel.id, channel, `${channel.proto}:${channel.description}`);
        const h = this.allocHandle(proc, adapter);

        debug('channel', `opened ${channel.proto}:${channel.description} as h ${h}`);
        return h;
    }

    /**
     * Get a channel from a handle.
     */
    private getChannelFromHandle(proc: Process, h: number): Channel | undefined {
        const handle = this.getHandle(proc, h);
        if (!handle || handle.type !== 'channel') return undefined;
        return (handle as ChannelHandleAdapter).getChannel();
    }

    // =========================================================================
    // Pubsub
    // =========================================================================

    /**
     * Publish a message to all matching pubsub subscribers.
     *
     * @param topic - Topic to publish to
     * @param data - Message payload
     * @param sourcePortId - Port ID of publisher (to avoid echo)
     */
    private publishPubsub(topic: string, data: Uint8Array, sourcePortId: string): void {
        const message = {
            from: topic,
            data,
            meta: {
                timestamp: Date.now(),
            },
        };

        for (const port of this.pubsubPorts) {
            // Don't echo back to sender
            if (port.id === sourcePortId) continue;

            // Check if any pattern matches
            const patterns = port.getPatterns();
            for (const pattern of patterns) {
                if (matchTopic(pattern, topic)) {
                    port.enqueue(message);
                    break; // Only deliver once per port
                }
            }
        }
    }

    // ========================================================================
    // Service Management
    // ========================================================================

    /**
     * Log a service error to the console.
     */
    private logServiceError(service: string, context: string, err: unknown): void {
        this.hal.console.error(
            new TextEncoder().encode(`service ${service}: ${context}: ${formatError(err)}\n`)
        );
    }

    /**
     * Load services from /etc/services/*.json
     */
    private async loadServices(): Promise<void> {
        // Ensure /etc/services exists (create recursively if needed)
        try {
            await this.vfs.stat('/etc/services', 'kernel');
        } catch {
            await this.vfs.mkdir('/etc/services', 'kernel', { recursive: true });
        }

        // Read service definitions
        for await (const entry of this.vfs.readdir('/etc/services', 'kernel')) {
            if (!entry.name.endsWith('.json')) continue;

            const serviceName = entry.name.replace(/\.json$/, '');
            const path = `/etc/services/${entry.name}`;

            try {
                const handle = await this.vfs.open(path, { read: true }, 'kernel');
                const chunks: Uint8Array[] = [];
                while (true) {
                    const chunk = await handle.read(65536);
                    if (chunk.length === 0) break;
                    chunks.push(chunk);
                }
                await handle.close();

                const total = chunks.reduce((sum, c) => sum + c.length, 0);
                const combined = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    combined.set(chunk, offset);
                    offset += chunk.length;
                }

                const content = new TextDecoder().decode(combined);
                const def = JSON.parse(content) as ServiceDef;

                // Validate handler exists in VFS (add .ts extension if needed)
                const handlerPath = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';
                try {
                    await this.vfs.stat(handlerPath, 'kernel');
                } catch {
                    this.logServiceError(serviceName, 'unknown handler', def.handler);
                    continue;
                }

                this.services.set(serviceName, def);

                // Activate the service
                await this.activateService(serviceName, def);
            } catch (err) {
                this.logServiceError(serviceName, 'load failed', err);
            }
        }
    }





    /**
     * Activate a service based on its definition.
     */
    private async activateService(name: string, def: ServiceDef): Promise<void> {
        const activation = def.activate;

        switch (activation.type) {
            case 'boot':
                // Spawn immediately
                await this.spawnServiceHandler(name, def);
                break;

            case 'tcp:listen': {
                // Create listener and spawn on each connection
                // Default to loopback for security - services must explicitly opt-in to bind to all interfaces
                const hostname = activation.host ?? '127.0.0.1';
                const listener = await this.hal.network.listen(activation.port, {
                    hostname,
                });

                const portId = this.hal.entropy.uuid();
                const addr = listener.addr();
                const description = `service:${name}:tcp:${addr.hostname}:${addr.port}`;
                const port = new ListenerPort(portId, listener, description);

                this.activationPorts.set(name, port);

                // Start accept loop
                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => {
                    if (msg.socket) {
                        const stat = msg.socket.stat();
                        debug('tcp', `${name}: accepted from ${stat.remoteAddr}:${stat.remotePort}`);
                        return {
                            socket: msg.socket,
                            activation: {
                                op: 'tcp',
                                data: {
                                    remoteAddr: stat.remoteAddr,
                                    remotePort: stat.remotePort,
                                    localAddr: stat.localAddr,
                                    localPort: stat.localPort,
                                },
                            },
                        };
                    }
                    return null;
                });
                break;
            }

            case 'pubsub': {
                // Subscribe and spawn on each message
                const portId = this.hal.entropy.uuid();
                const patterns = [activation.topic];
                const description = `service:${name}:pubsub:${activation.topic}`;

                const publishFn = (topic: string, data: Uint8Array, sourcePortId: string) => {
                    this.publishPubsub(topic, data, sourcePortId);
                };
                const unsubscribeFn = () => {
                    this.pubsubPorts.delete(port);
                };

                const port = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
                this.pubsubPorts.add(port);
                this.activationPorts.set(name, port);

                // Start message loop
                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => ({
                    activation: {
                        op: 'pubsub',
                        data: { topic: msg.from, payload: msg.data },
                    },
                }));
                break;
            }

            case 'watch': {
                // Watch and spawn on each event
                const portId = this.hal.entropy.uuid();
                const description = `service:${name}:watch:${activation.pattern}`;

                const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                    return this.vfs.watch(pattern, 'kernel');
                };

                const port = new WatchPort(portId, activation.pattern, vfsWatch, description);
                this.activationPorts.set(name, port);

                // Start watch loop
                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => ({
                    activation: {
                        op: 'watch',
                        data: { path: msg.from, event: msg.meta?.op, content: msg.data },
                    },
                }));
                break;
            }

            case 'udp': {
                // Bind UDP and spawn on each datagram
                const portId = this.hal.entropy.uuid();
                const description = `service:${name}:udp:${activation.host ?? '0.0.0.0'}:${activation.port}`;

                const port = new UdpPort(portId, { bind: activation.port, address: activation.host }, description);
                this.activationPorts.set(name, port);

                // Start datagram loop
                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runActivationLoop(name, def, port, abort.signal, (msg) => ({
                    activation: {
                        op: 'udp',
                        data: { from: msg.from, payload: msg.data },
                    },
                }));
                break;
            }
        }
    }

    /**
     * Unified activation loop for all service activation types.
     *
     * @param name - Service name
     * @param def - Service definition
     * @param port - Port to receive from
     * @param signal - Abort signal for graceful shutdown
     * @param transform - Transforms port message to spawn input
     */
    private async runActivationLoop(
        name: string,
        def: ServiceDef,
        port: Port,
        signal: AbortSignal,
        transform: (msg: import('@src/kernel/resource.js').PortMessage) => {
            socket?: import('@src/hal/network.js').Socket;
            activation?: Message;
        } | null
    ): Promise<void> {
        try {
            while (!signal.aborted) {
                const msg = await port.recv();

                if (signal.aborted) {
                    // Clean up socket if present (for TCP activation)
                    if (msg.socket) {
                        await msg.socket.close().catch((err) => {
                            debug('cleanup', `socket close on abort failed: ${formatError(err)}`);
                        });
                    }
                    break;
                }

                const input = transform(msg);
                if (input) {
                    this.spawnServiceHandler(name, def, input.socket, input.activation).catch((err) => {
                        this.logServiceError(name, 'spawn failed', err);
                        // Clean up socket on spawn failure (for TCP activation)
                        if (input.socket) {
                            input.socket.close().catch((closeErr) => {
                                debug('cleanup', `socket close on spawn error failed: ${formatError(closeErr)}`);
                            });
                        }
                    });
                }
            }
        } catch (err) {
            if (!signal.aborted) {
                this.logServiceError(name, 'activation loop error', err);
            }
        }
    }

    /**
     * Spawn a service handler process.
     *
     * For socket activation: socket becomes fd 0/1/2 (bidirectional)
     * For io config: uses ProcessIOHandle with configured sources/targets
     * For all activations: activation message available via getActivation syscall
     */
    private async spawnServiceHandler(
        name: string,
        def: ServiceDef,
        socket?: import('@src/hal/network.js').Socket,
        activation?: Message
    ): Promise<void> {
        // Handler path is a VFS path (e.g., /bin/telnetd), add .ts extension if needed
        const entry = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';

        const proc = this.createProcess({ cmd: def.handler });

        // Store activation message for retrieval via syscall
        proc.activationMessage = activation;

        // Setup stdio based on activation type and io config
        if (socket) {
            // Socket activation: socket on fd 0/1/2 (bidirectional)
            const stat = socket.stat();
            const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
            const adapter = new SocketHandleAdapter(this.hal.entropy.uuid(), socket, description);
            this.handles.set(adapter.id, adapter);
            this.handleRefs.set(adapter.id, 3); // Shared by stdin, stdout, stderr
            proc.handles.set(0, adapter.id);
            proc.handles.set(1, adapter.id);
            proc.handles.set(2, adapter.id);
        } else if (def.io) {
            // IO config: use ProcessIOHandle with configured sources/targets
            await this.setupServiceIO(proc, def);
        } else {
            // Default: console on all fds
            await this.setupServiceStdio(proc, 0);
            await this.setupServiceStdio(proc, 1);
            await this.setupServiceStdio(proc, 2);
        }

        // Start worker
        debug('spawn', `${name}: spawning worker for ${entry}`);
        proc.worker = await this.spawnWorker(proc, entry);
        proc.state = 'running';
        debug('spawn', `${name}: worker started, pid=${proc.id.slice(0, 8)}`);

        // Register in process table
        this.processes.register(proc);
    }

    /**
     * Setup a stdio handle to console for service processes.
     */
    private async setupServiceStdio(proc: Process, h: number): Promise<void> {
        const flags = h === 0 ? { read: true } : { write: true };
        const vfsHandle = await this.vfs.open(CONSOLE_PATH, flags, 'kernel');
        const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);
        this.handles.set(adapter.id, adapter);
        this.handleRefs.set(adapter.id, 1);
        proc.handles.set(h, adapter.id);
    }

    /**
     * Create a handle from an IO source config.
     */
    private async createIOSourceHandle(source: IOSource, proc: Process): Promise<Handle> {
        switch (source.type) {
            case 'console': {
                const vfsHandle = await this.vfs.open(CONSOLE_PATH, { read: true }, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }

            case 'file': {
                const vfsHandle = await this.vfs.open(source.path, { read: true }, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }

            case 'null': {
                // Return a handle that always returns EOF
                return {
                    id: this.hal.entropy.uuid(),
                    type: 'file' as const,
                    description: '/dev/null',
                    closed: false,
                    async *send() { yield respond.done(); },
                    async close() {},
                };
            }

            case 'pubsub': {
                const patterns = Array.isArray(source.subscribe)
                    ? source.subscribe
                    : [source.subscribe];
                const portId = this.hal.entropy.uuid();
                const description = `pubsub:${patterns.join(',')}`;

                const publishFn = (topic: string, data: Uint8Array, sourcePortId: string) => {
                    this.publishPubsub(topic, data, sourcePortId);
                };
                const unsubscribeFn = () => {
                    this.pubsubPorts.delete(port);
                };

                const port = new PubsubPort(portId, patterns, publishFn, unsubscribeFn, description);
                this.pubsubPorts.add(port);

                return new PortSourceAdapter(portId, port, description);
            }

            case 'watch': {
                const portId = this.hal.entropy.uuid();
                const description = `watch:${source.pattern}`;

                const vfsWatch = (pattern: string): AsyncIterable<WatchEvent> => {
                    return this.vfs.watch(pattern, proc.id);
                };

                const port = new WatchPort(portId, source.pattern, vfsWatch, description);
                return new PortSourceAdapter(portId, port, description);
            }

            case 'udp': {
                const portId = this.hal.entropy.uuid();
                const description = `udp:${source.address ?? '0.0.0.0'}:${source.bind}`;
                const port = new UdpPort(portId, { bind: source.bind, address: source.address }, description);
                return new PortSourceAdapter(portId, port, description);
            }
        }
    }

    /**
     * Create a handle from an IO target config.
     */
    private async createIOTargetHandle(target: IOTarget): Promise<Handle> {
        switch (target.type) {
            case 'console': {
                const vfsHandle = await this.vfs.open(CONSOLE_PATH, { write: true }, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }

            case 'file': {
                const flags = {
                    write: true,
                    create: target.flags?.create ?? true,
                    append: target.flags?.append ?? false,
                };
                const vfsHandle = await this.vfs.open(target.path, flags, 'kernel');
                return new FileHandleAdapter(vfsHandle.id, vfsHandle);
            }

            case 'null': {
                // Return a handle that discards all writes
                return {
                    id: this.hal.entropy.uuid(),
                    type: 'file' as const,
                    description: '/dev/null',
                    closed: false,
                    async *send() { yield respond.ok(); },
                    async close() {},
                };
            }
        }
    }

    /**
     * Setup service I/O using ProcessIOHandle.
     *
     * Creates ProcessIOHandle wrappers for stdin/stdout/stderr and wires up
     * the configured sources and targets.
     */
    private async setupServiceIO(proc: Process, def: ServiceDef): Promise<void> {
        const io = def.io ?? {};

        // Create stdin ProcessIOHandle
        const stdinSource = io.stdin
            ? await this.createIOSourceHandle(io.stdin, proc)
            : await this.createIOSourceHandle({ type: 'console' }, proc);

        const stdinHandle = new ProcessIOHandle(
            this.hal.entropy.uuid(),
            `stdin:${proc.cmd}`,
            { source: stdinSource }
        );
        this.handles.set(stdinHandle.id, stdinHandle);
        this.handleRefs.set(stdinHandle.id, 1);
        proc.handles.set(0, stdinHandle.id);

        // Create stdout ProcessIOHandle
        const stdoutTarget = io.stdout
            ? await this.createIOTargetHandle(io.stdout)
            : await this.createIOTargetHandle({ type: 'console' });

        const stdoutHandle = new ProcessIOHandle(
            this.hal.entropy.uuid(),
            `stdout:${proc.cmd}`,
            { target: stdoutTarget }
        );
        this.handles.set(stdoutHandle.id, stdoutHandle);
        this.handleRefs.set(stdoutHandle.id, 1);
        proc.handles.set(1, stdoutHandle.id);

        // Create stderr ProcessIOHandle
        const stderrTarget = io.stderr
            ? await this.createIOTargetHandle(io.stderr)
            : await this.createIOTargetHandle({ type: 'console' });

        const stderrHandle = new ProcessIOHandle(
            this.hal.entropy.uuid(),
            `stderr:${proc.cmd}`,
            { target: stderrTarget }
        );
        this.handles.set(stderrHandle.id, stderrHandle);
        this.handleRefs.set(stderrHandle.id, 1);
        proc.handles.set(2, stderrHandle.id);
    }

    // ========================================================================
    // Public accessors for testing
    // ========================================================================

    /**
     * Get process table (for testing).
     */
    getProcessTable(): ProcessTable {
        return this.processes;
    }

    /**
     * Check if booted.
     */
    isBooted(): boolean {
        return this.booted;
    }

    /**
     * Get loaded services (for testing).
     */
    getServices(): Map<string, ServiceDef> {
        return this.services;
    }

    // ========================================================================
    // Worker Pool Syscalls
    // ========================================================================

    /**
     * Lease a worker from a named pool.
     *
     * @param proc - Calling process
     * @param pool - Pool name (defaults to 'freelance')
     * @returns Worker UUID
     */
    private async leaseWorker(proc: Process, pool?: string): Promise<string> {
        const worker = await this.poolManager.lease(pool);

        // Track worker ownership
        let procWorkers = this.leasedWorkers.get(proc.id);
        if (!procWorkers) {
            procWorkers = new Map();
            this.leasedWorkers.set(proc.id, procWorkers);
        }
        procWorkers.set(worker.id, worker);

        return worker.id;
    }

    /**
     * Load a script into a leased worker.
     */
    private async workerLoad(proc: Process, workerId: string, path: string): Promise<void> {
        const worker = this.getLeasedWorker(proc, workerId);
        await worker.load(path);
    }

    /**
     * Send a message to a leased worker.
     */
    private async workerSend(proc: Process, workerId: string, msg: unknown): Promise<void> {
        const worker = this.getLeasedWorker(proc, workerId);
        await worker.send(msg);
    }

    /**
     * Receive a message from a leased worker.
     */
    private async workerRecv(proc: Process, workerId: string): Promise<unknown> {
        const worker = this.getLeasedWorker(proc, workerId);
        return worker.recv();
    }

    /**
     * Release a leased worker back to the pool.
     */
    private async workerRelease(proc: Process, workerId: string): Promise<void> {
        const procWorkers = this.leasedWorkers.get(proc.id);
        if (!procWorkers) {
            throw new EBADF(`No workers leased by process ${proc.id}`);
        }

        const worker = procWorkers.get(workerId);
        if (!worker) {
            throw new EBADF(`Worker not found: ${workerId}`);
        }

        await worker.release();
        procWorkers.delete(workerId);

        if (procWorkers.size === 0) {
            this.leasedWorkers.delete(proc.id);
        }
    }

    /**
     * Get a leased worker by ID.
     */
    private getLeasedWorker(proc: Process, workerId: string): LeasedWorker {
        const procWorkers = this.leasedWorkers.get(proc.id);
        if (!procWorkers) {
            throw new EBADF(`No workers leased by process ${proc.id}`);
        }

        const worker = procWorkers.get(workerId);
        if (!worker) {
            throw new EBADF(`Worker not found: ${workerId}`);
        }

        return worker;
    }

    /**
     * Release all workers when a process exits.
     */
    private releaseProcessWorkers(proc: Process): void {
        const procWorkers = this.leasedWorkers.get(proc.id);
        if (procWorkers) {
            for (const [workerId, worker] of procWorkers.entries()) {
                worker.release().catch((err) => {
                    debug('cleanup', `worker ${workerId} release failed: ${(err as Error).message}`);
                });
            }
            this.leasedWorkers.delete(proc.id);
        }
    }
}
