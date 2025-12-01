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
    SyscallResponse,
    SignalMessage,
    KernelMessage,
    BootEnv,
} from '@src/kernel/types.js';
import { SIGTERM, SIGKILL, TERM_GRACE_MS } from '@src/kernel/types.js';
import { ProcessTable } from '@src/kernel/process-table.js';
import { MAX_FDS, MAX_PORTS } from '@src/kernel/types.js';
import {
    SyscallDispatcher,
    createFileSyscalls,
    createMiscSyscalls,
    createNetworkSyscalls,
} from '@src/kernel/syscalls.js';
import { ESRCH, ECHILD, ProcessExited, EBADF, EPERM, EINVAL, ENOSYS, EMFILE } from '@src/kernel/errors.js';
import type { Resource, Port } from '@src/kernel/resource.js';
import type { WatchEvent } from '@src/vfs/model.js';
import { FileResource, SocketResource, ListenerPort, WatchPort, UdpPort, PubsubPort, matchTopic, PipeBuffer, PipeResource } from '@src/kernel/resource.js';
import type { ProcessPortMessage } from '@src/kernel/syscalls.js';
import type { ServiceDef, Activation } from '@src/kernel/services.js';
import { loadMounts } from '@src/kernel/mounts.js';
import { copyRomToVfs } from '@src/kernel/boot.js';
import { VFSLoader } from '@src/kernel/loader.js';
import { PoolManager, type LeasedWorker } from '@src/kernel/pool.js';

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
 * Kernel class
 */
export class Kernel {
    private hal: HAL;
    private vfs: VFS;
    private processes: ProcessTable;
    private syscalls: SyscallDispatcher;
    private resources: Map<string, Resource> = new Map();
    private resourceRefs: Map<string, number> = new Map(); // Reference counts
    private ports: Map<string, Port> = new Map();
    private portRefs: Map<string, number> = new Map(); // Reference counts
    private pubsubPorts: Set<PubsubPort> = new Set(); // All pubsub ports for routing
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
        // Process syscalls
        this.syscalls.registerAll({
            spawn: (proc, entry, opts) => this.spawn(proc, entry as string, opts as SpawnOpts),
            exit: (proc, code) => this.exit(proc, code as number),
            kill: (proc, pid, signal) => this.kill(proc, pid as number, signal as number | undefined),
            wait: (proc, pid) => this.wait(proc, pid as number),
            getpid: (proc) => this.getpid(proc),
            getppid: (proc) => this.getppid(proc),
        });

        // File syscalls
        this.syscalls.registerAll(
            createFileSyscalls(
                this.vfs,
                this.hal,
                (proc, fd) => this.getResource(proc, fd),
                (proc, path, flags) => this.openFile(proc, path, flags),
                (proc, fd) => this.closeResource(proc, fd)
            )
        );

        // Network syscalls
        this.syscalls.registerAll(
            createNetworkSyscalls(
                this.hal,
                (proc, host, port) => this.connectTcp(proc, host, port),
                (proc, type, opts) => this.createPort(proc, type, opts),
                (proc, portId) => this.getPort(proc, portId),
                (proc, portId) => this.recvPort(proc, portId),
                (proc, portId) => this.closePort(proc, portId)
            )
        );

        // Misc syscalls
        this.syscalls.registerAll(createMiscSyscalls());

        // Pipe syscall
        this.syscalls.register('pipe', (proc) => this.createPipe(proc));

        // Redirect syscalls
        this.syscalls.register('redirect', (proc, args) => {
            const { target, source } = args as { target: number; source: number };
            return this.redirectFd(proc, target, source);
        });
        this.syscalls.register('restore', (proc, args) => {
            const { target, saved } = args as { target: number; saved: string };
            return this.restoreFd(proc, target, saved);
        });

        // Worker pool syscalls
        this.syscalls.register('lease', (proc, pool) =>
            this.leaseWorker(proc, pool as string | undefined)
        );
        this.syscalls.register('worker:load', (proc, args) => {
            const { workerId, path } = args as { workerId: string; path: string };
            return this.workerLoad(proc, workerId, path);
        });
        this.syscalls.register('worker:send', (proc, args) => {
            const { workerId, msg } = args as { workerId: string; msg: unknown };
            return this.workerSend(proc, workerId, msg);
        });
        this.syscalls.register('worker:recv', (proc, workerId) =>
            this.workerRecv(proc, workerId as string)
        );
        this.syscalls.register('worker:release', (proc, workerId) =>
            this.workerRelease(proc, workerId as string)
        );
        this.syscalls.register('pool:stats', () => this.poolManager.stats());
    }

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
        const initId = this.hal.entropy.uuid();
        const init: Process = {
            id: initId,
            parent: '',
            worker: null as unknown as Worker, // Will be set when spawned
            state: 'starting',
            cmd: env.initPath,
            cwd: '/',
            env: { ...env.env },
            args: env.initArgs ?? [env.initPath],
            fds: new Map(),
            ports: new Map(),
            nextFd: 3,
            nextPort: 0,
            children: new Map(),
            nextPid: 1,
        };

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
            await port.close().catch(() => {});
        }

        // Clear process table and all maps
        this.processes.clear();
        this.resources.clear();
        this.resourceRefs.clear();
        this.ports.clear();
        this.portRefs.clear();
        this.waiters.clear();
        this.services.clear();
        this.activationPorts.clear();
        this.activationAborts.clear();

        // Shutdown worker pools
        this.poolManager.shutdown();
        this.leasedWorkers.clear();

        this.booted = false;
    }

    /**
     * Spawn a child process.
     */
    private async spawn(parent: Process, entry: string, opts?: SpawnOpts): Promise<number> {
        const procId = this.hal.entropy.uuid();

        const proc: Process = {
            id: procId,
            parent: parent.id,
            worker: null as unknown as Worker,
            state: 'starting',
            cmd: entry,
            cwd: opts?.cwd ?? parent.cwd,
            env: { ...parent.env, ...opts?.env },
            args: opts?.args ?? [entry],
            fds: new Map(),
            ports: new Map(),
            nextFd: 3,
            nextPort: 0,
            children: new Map(),
            nextPid: 1,
        };

        // Setup stdio
        this.setupStdio(proc, parent, opts);

        // Create worker
        proc.worker = await this.spawnWorker(proc, entry);
        proc.state = 'running';

        // Register in process table
        this.processes.register(proc);

        // Assign PID in parent's namespace
        const pid = parent.nextPid++;
        parent.children.set(pid, procId);

        return pid;
    }

    /**
     * Exit the current process.
     */
    private async exit(proc: Process, code: number): Promise<never> {
        proc.exitCode = code;
        proc.state = 'zombie';

        // Close all file descriptors
        for (const [fd] of proc.fds) {
            try {
                await this.closeResource(proc, fd);
            } catch {
                // Ignore errors during cleanup
            }
        }

        // Close all ports
        for (const [portId] of proc.ports) {
            try {
                await this.closePort(proc, portId);
            } catch {
                // Ignore errors during cleanup
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
     */
    private async wait(caller: Process, pid: number): Promise<ExitStatus> {
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

        // Wait for exit
        return new Promise(resolve => {
            const waiters = this.waiters.get(target.id) ?? [];
            waiters.push((status) => {
                // Reap the zombie
                this.reapZombie(caller, pid, target);
                resolve({ ...status, pid });
            });
            this.waiters.set(target.id, waiters);
        });
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
        if (msg.type !== 'syscall') {
            return;
        }

        const request = msg as SyscallRequest;
        let response: SyscallResponse;

        debug('syscall', `${proc.cmd}: ${request.name}(${JSON.stringify(request.args).slice(0, 100)})`);

        try {
            const result = await this.syscalls.dispatch(proc, request.name, request.args);
            response = {
                type: 'response',
                id: request.id,
                result,
            };
            debug('syscall', `${proc.cmd}: ${request.name} -> ok`);
        } catch (error) {
            const err = error as Error & { code?: string };
            response = {
                type: 'response',
                id: request.id,
                error: {
                    code: err.code ?? 'UNKNOWN',
                    message: err.message,
                },
            };
            debug('syscall', `${proc.cmd}: ${request.name} -> error: ${err.code ?? 'UNKNOWN'}`);
        }

        // Send response back to process
        proc.worker.postMessage(response);
    }

    /**
     * Setup stdio for init process.
     *
     * Opens /dev/console for stdin, stdout, stderr.
     */
    private async setupInitStdio(init: Process): Promise<void> {
        // Open console for stdin (read-only)
        const stdinHandle = await this.vfs.open(CONSOLE_PATH, { read: true }, 'kernel');
        const stdinResource = new FileResource(stdinHandle.id, stdinHandle);
        this.resources.set(stdinResource.id, stdinResource);
        init.fds.set(0, stdinResource.id);

        // Open console for stdout (write-only)
        const stdoutHandle = await this.vfs.open(CONSOLE_PATH, { write: true }, 'kernel');
        const stdoutResource = new FileResource(stdoutHandle.id, stdoutHandle);
        this.resources.set(stdoutResource.id, stdoutResource);
        init.fds.set(1, stdoutResource.id);

        // Open console for stderr (write-only)
        const stderrHandle = await this.vfs.open(CONSOLE_PATH, { write: true }, 'kernel');
        const stderrResource = new FileResource(stderrHandle.id, stderrHandle);
        this.resources.set(stderrResource.id, stderrResource);
        init.fds.set(2, stderrResource.id);
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
            const resourceId = parent.fds.get(stdin);
            if (resourceId) {
                proc.fds.set(0, resourceId);
                this.refResource(resourceId);
            }
        }

        if (typeof stdout === 'number') {
            const resourceId = parent.fds.get(stdout);
            if (resourceId) {
                proc.fds.set(1, resourceId);
                this.refResource(resourceId);
            }
        }

        if (typeof stderr === 'number') {
            const resourceId = parent.fds.get(stderr);
            if (resourceId) {
                proc.fds.set(2, resourceId);
                this.refResource(resourceId);
            }
        }

        // TODO: Handle 'pipe' option to create new pipes
    }

    /**
     * Increment reference count for a resource.
     */
    private refResource(resourceId: string): void {
        const refs = this.resourceRefs.get(resourceId) ?? 1;
        this.resourceRefs.set(resourceId, refs + 1);
    }

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

        // Clean up resources with refcounting (fire-and-forget, don't await)
        for (const resourceId of proc.fds.values()) {
            this.unrefResource(resourceId);
        }
        proc.fds.clear();

        // Clean up ports with refcounting (fire-and-forget, don't await)
        for (const portUuid of proc.ports.values()) {
            this.unrefPort(portUuid);
        }
        proc.ports.clear();

        // Release any leased workers back to pool
        this.releaseProcessWorkers(proc);

        // Reparent children
        this.processes.reparentOrphans(proc.id);

        // Notify waiters
        this.notifyWaiters(proc);
    }

    /**
     * Decrement reference count for a resource, closing if last ref.
     */
    private unrefResource(resourceId: string): void {
        const refs = (this.resourceRefs.get(resourceId) ?? 1) - 1;
        if (refs <= 0) {
            const resource = this.resources.get(resourceId);
            if (resource) {
                resource.close().catch(() => {}); // Ignore errors
                this.resources.delete(resourceId);
            }
            this.resourceRefs.delete(resourceId);
        } else {
            this.resourceRefs.set(resourceId, refs);
        }
    }

    /**
     * Decrement reference count for a port, closing if last ref.
     */
    private unrefPort(portUuid: string): void {
        const refs = (this.portRefs.get(portUuid) ?? 1) - 1;
        if (refs <= 0) {
            const port = this.ports.get(portUuid);
            if (port) {
                port.close().catch(() => {}); // Ignore errors
                this.ports.delete(portUuid);
            }
            this.portRefs.delete(portUuid);
        } else {
            this.portRefs.set(portUuid, refs);
        }
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

    /**
     * Get resource for a file descriptor.
     */
    private getResource(proc: Process, fd: number): Resource | undefined {
        const resourceId = proc.fds.get(fd);
        if (!resourceId) return undefined;

        return this.resources.get(resourceId);
    }

    /**
     * Open a file and allocate fd.
     */
    private async openFile(proc: Process, path: string, flags: import('@src/kernel/types.js').OpenFlags): Promise<number> {
        if (proc.fds.size >= MAX_FDS) {
            throw new EMFILE('Too many open files');
        }

        const handle = await this.vfs.open(path, flags, proc.id);

        // Create resource wrapper
        const resource = new FileResource(handle.id, handle);
        this.resources.set(resource.id, resource);

        // Allocate fd
        const fd = proc.nextFd++;
        proc.fds.set(fd, resource.id);

        return fd;
    }

    /**
     * Connect TCP or Unix socket and allocate fd.
     *
     * For TCP: host is hostname/IP, port is port number
     * For Unix: host is socket path, port is 0
     */
    private async connectTcp(proc: Process, host: string, port: number): Promise<number> {
        if (proc.fds.size >= MAX_FDS) {
            throw new EMFILE('Too many open files');
        }

        const socket = await this.hal.network.connect(host, port);

        // Create resource wrapper
        const resourceId = this.hal.entropy.uuid();
        const isUnix = port === 0;
        const description = isUnix
            ? `unix:${host}`
            : `tcp:${socket.stat().remoteAddr}:${socket.stat().remotePort}`;
        const resource = new SocketResource(resourceId, socket, description);
        this.resources.set(resourceId, resource);

        // Allocate fd
        const fd = proc.nextFd++;
        proc.fds.set(fd, resourceId);

        return fd;
    }

    /**
     * Close a file descriptor.
     *
     * Uses reference counting - only closes the underlying resource
     * when the last reference is released.
     */
    private async closeResource(proc: Process, fd: number): Promise<void> {
        const resourceId = proc.fds.get(fd);
        if (!resourceId) {
            throw new EBADF(`Bad file descriptor: ${fd}`);
        }

        // Remove fd from process
        proc.fds.delete(fd);

        // Decrement refcount
        const refs = (this.resourceRefs.get(resourceId) ?? 1) - 1;
        if (refs <= 0) {
            // Last reference - close the resource
            const resource = this.resources.get(resourceId);
            if (resource) {
                await resource.close();
                this.resources.delete(resourceId);
            }
            this.resourceRefs.delete(resourceId);
        } else {
            this.resourceRefs.set(resourceId, refs);
        }
    }

    /**
     * Create a pipe and return [readFd, writeFd].
     *
     * Creates a unidirectional data channel. Data written to writeFd
     * can be read from readFd. Closing writeFd signals EOF to readers.
     */
    private createPipe(proc: Process): [number, number] {
        // Check fd limit (need 2 fds)
        if (proc.fds.size + 2 > MAX_FDS) {
            throw new EMFILE('Too many open files');
        }

        // Create shared buffer
        const buffer = new PipeBuffer();
        const pipeId = this.hal.entropy.uuid();

        // Create read end
        const readResource = new PipeResource(
            `${pipeId}:read`,
            buffer,
            'read',
            `pipe:${pipeId}:read`
        );
        this.resources.set(readResource.id, readResource);
        const readFd = proc.nextFd++;
        proc.fds.set(readFd, readResource.id);

        // Create write end
        const writeResource = new PipeResource(
            `${pipeId}:write`,
            buffer,
            'write',
            `pipe:${pipeId}:write`
        );
        this.resources.set(writeResource.id, writeResource);
        const writeFd = proc.nextFd++;
        proc.fds.set(writeFd, writeResource.id);

        return [readFd, writeFd];
    }

    /**
     * Redirect a file descriptor to point to the same resource as another fd.
     *
     * Returns the saved resource ID so it can be restored later.
     * The caller must call restoreFd to restore the original resource.
     */
    private redirectFd(proc: Process, targetFd: number, sourceFd: number): string {
        const sourceResourceId = proc.fds.get(sourceFd);
        if (!sourceResourceId) {
            throw new EBADF(`Bad source file descriptor: ${sourceFd}`);
        }

        const savedResourceId = proc.fds.get(targetFd);
        if (!savedResourceId) {
            throw new EBADF(`Bad target file descriptor: ${targetFd}`);
        }

        // Point target fd to source's resource
        proc.fds.set(targetFd, sourceResourceId);

        // Increment refcount on the source resource
        const refs = this.resourceRefs.get(sourceResourceId) ?? 1;
        this.resourceRefs.set(sourceResourceId, refs + 1);

        return savedResourceId;
    }

    /**
     * Restore a file descriptor to its original resource.
     *
     * This should be called after redirectFd to restore the original resource.
     */
    private async restoreFd(proc: Process, targetFd: number, savedResourceId: string): Promise<void> {
        const currentResourceId = proc.fds.get(targetFd);
        if (!currentResourceId) {
            throw new EBADF(`Bad file descriptor: ${targetFd}`);
        }

        // Restore the original resource
        proc.fds.set(targetFd, savedResourceId);

        // Decrement refcount on the current resource (it was redirected)
        const refs = (this.resourceRefs.get(currentResourceId) ?? 1) - 1;
        if (refs <= 0) {
            // Don't close - redirected resources shouldn't be auto-closed here
            // The original fd that opened the resource will close it
            this.resourceRefs.delete(currentResourceId);
        } else {
            this.resourceRefs.set(currentResourceId, refs);
        }
    }

    /**
     * Create a port and allocate port id.
     */
    private async createPort(proc: Process, type: string, opts: unknown): Promise<number> {
        if (proc.ports.size >= MAX_PORTS) {
            throw new EMFILE('Too many open ports');
        }

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
                    const p = this.ports.get(portId) as PubsubPort | undefined;
                    if (p) {
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

        // Register port
        this.ports.set(port.id, port);

        // Allocate port id in process
        const localPortId = proc.nextPort++;
        proc.ports.set(localPortId, port.id);

        return localPortId;
    }

    /**
     * Get port for a port id.
     */
    private getPort(proc: Process, portId: number): Port | undefined {
        const portUuid = proc.ports.get(portId);
        if (!portUuid) return undefined;

        return this.ports.get(portUuid);
    }

    /**
     * Receive from port, auto-allocating fd for sockets.
     */
    private async recvPort(proc: Process, portId: number): Promise<ProcessPortMessage> {
        const port = this.getPort(proc, portId);
        if (!port) {
            throw new EBADF(`Bad port: ${portId}`);
        }

        const msg = await port.recv();

        // If message contains a socket, wrap it and allocate fd
        if (msg.socket) {
            if (proc.fds.size >= MAX_FDS) {
                // Can't accept - close the socket and throw
                await msg.socket.close();
                throw new EMFILE('Too many open files');
            }

            const resourceId = this.hal.entropy.uuid();
            const stat = msg.socket.stat();
            const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
            const resource = new SocketResource(resourceId, msg.socket, description);
            this.resources.set(resourceId, resource);

            // Allocate fd
            const fd = proc.nextFd++;
            proc.fds.set(fd, resourceId);

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

    /**
     * Close a port.
     */
    private async closePort(proc: Process, portId: number): Promise<void> {
        const portUuid = proc.ports.get(portId);
        if (!portUuid) {
            throw new EBADF(`Bad port: ${portId}`);
        }

        const port = this.ports.get(portUuid);
        if (port) {
            await port.close();
            this.ports.delete(portUuid);
        }

        proc.ports.delete(portId);
    }

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
     * Load services from /etc/services/*.json
     */
    private async loadServices(): Promise<void> {
        // Ensure /etc/services exists (create recursively if needed)
        try {
            await this.vfs.stat('/etc/services', 'kernel');
        } catch {
            await this.vfs.mkdir('/etc/services', 'kernel', { recursive: true });

            // Seed default services
            await this.seedDefaultServices();
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
                    this.hal.console.error(
                        new TextEncoder().encode(`service ${serviceName}: unknown handler ${def.handler}\n`)
                    );
                    continue;
                }

                this.services.set(serviceName, def);

                // Activate the service
                await this.activateService(serviceName, def);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.hal.console.error(
                    new TextEncoder().encode(`service ${serviceName}: ${msg}\n`)
                );
            }
        }
    }

    /**
     * Seed default service definitions.
     *
     * Called when /etc/services is first created.
     */
    private async seedDefaultServices(): Promise<void> {
        // Default telnetd service
        const telnetd: ServiceDef = {
            handler: '/bin/telnetd',
            activate: {
                type: 'tcp:listen',
                port: 2323,
            },
            description: 'Telnet server for shell access',
        };

        await this.writeServiceFile('telnetd', telnetd);
    }

    /**
     * Write a service definition file to VFS.
     */
    private async writeServiceFile(name: string, def: ServiceDef): Promise<void> {
        const path = `/etc/services/${name}.json`;
        const content = JSON.stringify(def, null, 2);
        const data = new TextEncoder().encode(content);

        const handle = await this.vfs.open(path, { write: true, create: true }, 'kernel');
        await handle.write(data);
        await handle.close();
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
                const listener = await this.hal.network.listen(activation.port, {
                    hostname: activation.host,
                });

                const portId = this.hal.entropy.uuid();
                const addr = listener.addr();
                const description = `service:${name}:tcp:${addr.hostname}:${addr.port}`;
                const port = new ListenerPort(portId, listener, description);

                this.activationPorts.set(name, port);

                // Start accept loop
                const abort = new AbortController();
                this.activationAborts.set(name, abort);

                this.runTcpActivationLoop(name, def, port, abort.signal);
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

                this.runPubsubActivationLoop(name, def, port, abort.signal);
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

                this.runWatchActivationLoop(name, def, port, abort.signal);
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

                this.runUdpActivationLoop(name, def, port, abort.signal);
                break;
            }
        }
    }

    /**
     * Run TCP listener activation loop.
     */
    private async runTcpActivationLoop(
        name: string,
        def: ServiceDef,
        port: ListenerPort,
        signal: AbortSignal
    ): Promise<void> {
        try {
            while (!signal.aborted) {
                const msg = await port.recv();

                if (signal.aborted) {
                    // Clean up the socket we just accepted
                    if (msg.socket) {
                        await msg.socket.close().catch(() => {});
                    }
                    break;
                }

                if (msg.socket) {
                    const stat = msg.socket.stat();
                    debug('tcp', `${name}: accepted connection from ${stat.remoteAddr}:${stat.remotePort}`);
                    // Spawn handler with socket as fd 0
                    this.spawnServiceHandler(name, def, msg.socket).catch((err) => {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        debug('tcp', `${name}: spawn failed: ${errMsg}`);
                        this.hal.console.error(
                            new TextEncoder().encode(`service ${name}: spawn failed: ${errMsg}\n`)
                        );
                        msg.socket?.close().catch(() => {});
                    });
                }
            }
        } catch (err) {
            if (!signal.aborted) {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.hal.console.error(
                    new TextEncoder().encode(`service ${name}: activation loop error: ${errMsg}\n`)
                );
            }
        }
    }

    /**
     * Run pubsub activation loop.
     */
    private async runPubsubActivationLoop(
        name: string,
        def: ServiceDef,
        port: PubsubPort,
        signal: AbortSignal
    ): Promise<void> {
        try {
            while (!signal.aborted) {
                const msg = await port.recv();

                if (signal.aborted) break;

                // Spawn handler with message data as fd 0 input
                this.spawnServiceHandler(name, def, undefined, msg.data).catch((err) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.hal.console.error(
                        new TextEncoder().encode(`service ${name}: spawn failed: ${errMsg}\n`)
                    );
                });
            }
        } catch (err) {
            if (!signal.aborted) {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.hal.console.error(
                    new TextEncoder().encode(`service ${name}: activation loop error: ${errMsg}\n`)
                );
            }
        }
    }

    /**
     * Run watch activation loop.
     */
    private async runWatchActivationLoop(
        name: string,
        def: ServiceDef,
        port: WatchPort,
        signal: AbortSignal
    ): Promise<void> {
        try {
            while (!signal.aborted) {
                const msg = await port.recv();

                if (signal.aborted) break;

                // Encode event as JSON for fd 0
                const eventData = new TextEncoder().encode(JSON.stringify({
                    path: msg.from,
                    op: msg.meta?.op,
                    data: msg.data ? Array.from(msg.data) : undefined,
                }));

                this.spawnServiceHandler(name, def, undefined, eventData).catch((err) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.hal.console.error(
                        new TextEncoder().encode(`service ${name}: spawn failed: ${errMsg}\n`)
                    );
                });
            }
        } catch (err) {
            if (!signal.aborted) {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.hal.console.error(
                    new TextEncoder().encode(`service ${name}: activation loop error: ${errMsg}\n`)
                );
            }
        }
    }

    /**
     * Run UDP activation loop.
     */
    private async runUdpActivationLoop(
        name: string,
        def: ServiceDef,
        port: UdpPort,
        signal: AbortSignal
    ): Promise<void> {
        try {
            while (!signal.aborted) {
                const msg = await port.recv();

                if (signal.aborted) break;

                // Encode datagram with source address for fd 0
                const datagram = new TextEncoder().encode(JSON.stringify({
                    from: msg.from,
                    data: msg.data ? Array.from(msg.data) : undefined,
                }));

                this.spawnServiceHandler(name, def, undefined, datagram).catch((err) => {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.hal.console.error(
                        new TextEncoder().encode(`service ${name}: spawn failed: ${errMsg}\n`)
                    );
                });
            }
        } catch (err) {
            if (!signal.aborted) {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.hal.console.error(
                    new TextEncoder().encode(`service ${name}: activation loop error: ${errMsg}\n`)
                );
            }
        }
    }

    /**
     * Spawn a service handler process.
     *
     * For socket activation: socket becomes fd 0 (bidirectional)
     * For message activation: data becomes readable on fd 0
     */
    private async spawnServiceHandler(
        name: string,
        def: ServiceDef,
        socket?: import('@src/hal/network.js').Socket,
        inputData?: Uint8Array
    ): Promise<void> {
        // Handler path is a VFS path (e.g., /bin/telnetd), add .ts extension if needed
        const entry = def.handler.endsWith('.ts') ? def.handler : def.handler + '.ts';

        const procId = this.hal.entropy.uuid();

        const proc: Process = {
            id: procId,
            parent: '', // Kernel is parent (no parent process)
            worker: null as unknown as Worker,
            state: 'starting',
            cmd: def.handler,
            cwd: '/',
            env: {},
            args: [def.handler],
            fds: new Map(),
            ports: new Map(),
            nextFd: 3,
            nextPort: 0,
            children: new Map(),
            nextPid: 1,
        };

        // Setup fd 0 based on activation type
        if (socket) {
            // Socket activation: fd 0 is the connected socket
            const resourceId = this.hal.entropy.uuid();
            const stat = socket.stat();
            const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
            const resource = new SocketResource(resourceId, socket, description);
            this.resources.set(resourceId, resource);
            proc.fds.set(0, resourceId);

            // fd 1 and 2 also point to the socket (like inetd)
            this.resourceRefs.set(resourceId, 3);
            proc.fds.set(1, resourceId);
            proc.fds.set(2, resourceId);
        } else if (inputData) {
            // Message activation: fd 0 is a pipe with pre-filled data
            const buffer = new PipeBuffer();
            buffer.write(inputData);
            buffer.closeWriteEnd(); // Signal EOF after the data

            const pipeId = this.hal.entropy.uuid();
            const readResource = new PipeResource(
                `${pipeId}:read`,
                buffer,
                'read',
                `service:${name}:stdin`
            );
            this.resources.set(readResource.id, readResource);
            proc.fds.set(0, readResource.id);

            // fd 1 and 2 go to console
            await this.setupServiceStdio(proc, 1);
            await this.setupServiceStdio(proc, 2);
        } else {
            // Boot activation: all stdio to console
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
     * Setup a stdio fd to console for service processes.
     */
    private async setupServiceStdio(proc: Process, fd: number): Promise<void> {
        const flags = fd === 0 ? { read: true } : { write: true };
        const handle = await this.vfs.open(CONSOLE_PATH, flags, 'kernel');
        const resource = new FileResource(handle.id, handle);
        this.resources.set(resource.id, resource);
        proc.fds.set(fd, resource.id);
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
            for (const worker of procWorkers.values()) {
                worker.release().catch(() => {}); // Best effort
            }
            this.leasedWorkers.delete(proc.id);
        }
    }
}
