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
import {
    SyscallDispatcher,
    createFileSyscalls,
    createMiscSyscalls,
    createNetworkSyscalls,
} from '@src/kernel/syscalls.js';
import { ESRCH, ECHILD, ProcessExited, EBADF, EPERM } from '@src/kernel/errors.js';
import type { Resource } from '@src/kernel/resource.js';
import { FileResource, SocketResource } from '@src/kernel/resource.js';

/**
 * Console device UUID for init stdio
 */
const CONSOLE_STDIN = '00000000-0000-0000-0000-000000000001';
const CONSOLE_STDOUT = '00000000-0000-0000-0000-000000000002';
const CONSOLE_STDERR = '00000000-0000-0000-0000-000000000003';

/**
 * Kernel class
 */
export class Kernel {
    private hal: HAL;
    private vfs: VFS;
    private processes: ProcessTable;
    private syscalls: SyscallDispatcher;
    private resources: Map<string, Resource> = new Map();
    private waiters: Map<string, ((status: ExitStatus) => void)[]> = new Map();
    private booted = false;

    constructor(hal: HAL, vfs: VFS) {
        this.hal = hal;
        this.vfs = vfs;
        this.processes = new ProcessTable();
        this.syscalls = new SyscallDispatcher();

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
                (proc, host, port) => this.connectTcp(proc, host, port)
            )
        );

        // Misc syscalls
        this.syscalls.registerAll(createMiscSyscalls());
    }

    /**
     * Boot the kernel.
     *
     * Initializes VFS and starts the init process.
     */
    async boot(env: BootEnv): Promise<void> {
        if (this.booted) {
            throw new Error('Kernel already booted');
        }

        // Initialize VFS
        await this.vfs.init();

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
            fds: new Map(),
            ports: new Map(),
            nextFd: 3,
            nextPort: 0,
            children: new Map(),
            nextPid: 1,
        };

        // Setup stdio for init
        init.fds.set(0, CONSOLE_STDIN);
        init.fds.set(1, CONSOLE_STDOUT);
        init.fds.set(2, CONSOLE_STDERR);

        // Start init worker
        init.worker = this.spawnWorker(init, env.initPath);
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

        // Send SIGTERM to all processes except init
        const init = this.processes.getInit();
        for (const proc of this.processes.all()) {
            if (proc !== init && proc.state === 'running') {
                this.deliverSignal(proc, SIGTERM);
            }
        }

        // Wait for grace period
        await new Promise(resolve => setTimeout(resolve, TERM_GRACE_MS));

        // Force kill remaining processes
        for (const proc of this.processes.all()) {
            if (proc.state === 'running') {
                this.forceExit(proc, 128 + SIGKILL);
            }
        }

        // Clear process table
        this.processes.clear();
        this.resources.clear();
        this.waiters.clear();

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
        proc.worker = this.spawnWorker(proc, entry);
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
        proc.ports.clear();

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
     */
    private spawnWorker(proc: Process, entry: string): Worker {
        const worker = new Worker(entry, {
            type: 'module',
            env: proc.env,
        });

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

        try {
            const result = await this.syscalls.dispatch(proc, request.name, request.args);
            response = {
                type: 'response',
                id: request.id,
                result,
            };
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
        }

        // Send response back to process
        proc.worker.postMessage(response);
    }

    /**
     * Setup stdio for a new process.
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
            }
        }

        if (typeof stdout === 'number') {
            const resourceId = parent.fds.get(stdout);
            if (resourceId) {
                proc.fds.set(1, resourceId);
            }
        }

        if (typeof stderr === 'number') {
            const resourceId = parent.fds.get(stderr);
            if (resourceId) {
                proc.fds.set(2, resourceId);
            }
        }

        // TODO: Handle 'pipe' option to create new pipes
    }

    /**
     * Force exit a process immediately.
     */
    private forceExit(proc: Process, code: number): void {
        if (proc.state === 'zombie') return;

        proc.exitCode = code;
        proc.state = 'zombie';

        // Terminate worker immediately
        proc.worker.terminate();

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
     * Connect TCP and allocate fd.
     */
    private async connectTcp(proc: Process, host: string, port: number): Promise<number> {
        const socket = await this.hal.network.connect(host, port);

        // Create resource wrapper
        const resourceId = this.hal.entropy.uuid();
        const stat = socket.stat();
        const description = `tcp:${stat.remoteAddr}:${stat.remotePort}`;
        const resource = new SocketResource(resourceId, socket, description);
        this.resources.set(resourceId, resource);

        // Allocate fd
        const fd = proc.nextFd++;
        proc.fds.set(fd, resourceId);

        return fd;
    }

    /**
     * Close a file descriptor.
     */
    private async closeResource(proc: Process, fd: number): Promise<void> {
        const resourceId = proc.fds.get(fd);
        if (!resourceId) {
            throw new EBADF(`Bad file descriptor: ${fd}`);
        }

        const resource = this.resources.get(resourceId);
        if (resource) {
            await resource.close();
            this.resources.delete(resourceId);
        }

        proc.fds.delete(fd);
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
}
