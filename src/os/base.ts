/**
 * BaseOS - Abstract base class for OS implementations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * BaseOS provides the foundation for both production (OS) and testing (TestOS)
 * implementations. It contains all shared functionality except the boot sequence.
 *
 * The class hierarchy:
 *   BaseOS (abstract)
 *   ├── Protected subsystem fields (__hal, __ems, __auth, __vfs, __kernel, __dispatcher, __gateway)
 *   ├── shutdown() - works for any subset of initialized layers
 *   ├── syscall() - requires kernel, throws if not booted with kernel
 *   ├── Convenience methods (spawn, kill, mount)
 *   ├── alias(), resolvePath()
 *   ├── isBooted()
 *   └── abstract boot()
 *
 *   OS extends BaseOS
 *   └── boot(opts?) - linear, all-or-nothing (production)
 *
 *   TestOS extends BaseOS
 *   ├── boot({ hal?, layers? }) - flexible partial boot
 *   └── internal* getters for direct subsystem access
 *
 * @module os/base
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HAL } from '@src/hal/index.js';
import { EINVAL } from '@src/hal/index.js';
import type { VFS } from '@src/vfs/vfs.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { fromCode } from '@src/hal/errors.js';
import type { OSConfig, OSEvents, OSEventName } from './types.js';
import type { EMS } from '@src/ems/ems.js';
import type { EntityOps } from '@src/ems/entity-ops.js';
import type { Auth } from '@src/auth/index.js';
import type { LLM } from '@src/llm/index.js';
import type { SyscallDispatcher } from '@src/syscall/index.js';
import type { Gateway } from '@src/gateway/index.js';

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * BaseOS - Abstract base class for OS implementations.
 *
 * Provides shared functionality for production (OS) and testing (TestOS):
 * - Subsystem field management
 * - Lifecycle management (shutdown)
 * - Syscall API
 * - Path aliasing
 * - Convenience helpers
 */
export abstract class BaseOS {
    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * OS configuration provided at construction.
     *
     * WHY: Stored for reference during boot().
     * INVARIANT: Never null after construction.
     */
    protected config: OSConfig;

    /**
     * Path aliases for convenient path resolution.
     *
     * WHY: Allows '@app' -> '/vol/app' style shortcuts in user code.
     * Can be modified at any time via alias().
     */
    protected aliases: Map<string, string> = new Map();

    // =========================================================================
    // SUBSYSTEM REFERENCES
    // =========================================================================

    /**
     * Hardware Abstraction Layer.
     *
     * WHY: Provides storage backend (memory/sqlite/postgres) and low-level I/O.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __hal: HAL | null = null;

    /**
     * Entity Management System.
     *
     * WHY: Provides entity storage, versioning, and queries.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __ems: EMS | null = null;

    /**
     * Authentication subsystem.
     *
     * WHY: Handles identity ("who are you?") for external clients.
     * Sets proc.user/session/expires on successful auth:token.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __auth: Auth | null = null;

    /**
     * Language Model subsystem.
     *
     * WHY: Provides stateless LLM inference for AI agents.
     * Reads provider/model config from EMS, dispatches to adapters.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __llm: LLM | null = null;

    /**
     * Virtual File System.
     *
     * WHY: Provides POSIX-like filesystem abstraction over EMS entities.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __vfs: VFS | null = null;

    /**
     * Process kernel.
     *
     * WHY: Manages process lifecycle, workers, and IPC.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __kernel: Kernel | null = null;

    /**
     * Syscall dispatcher.
     *
     * WHY: Routes syscalls to appropriate handlers and manages response streams.
     * Sits outside kernel to separate concerns.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __dispatcher: SyscallDispatcher | null = null;

    /**
     * External syscall gateway.
     *
     * WHY: Provides Unix socket interface for external apps (os-shell, displayd).
     * Runs in kernel context for direct syscall execution without IPC overhead.
     * INVARIANT: Non-null when booted === true.
     * NOTE: Protected to allow TestOS subclass to expose internals for testing.
     */
    protected __gateway: Gateway | null = null;

    // =========================================================================
    // LIFECYCLE STATE
    // =========================================================================

    /**
     * Boot state flag.
     *
     * WHY: Guards against double-boot and enables syscall validation.
     * INVARIANT: true only when all subsystems are initialized.
     */
    protected booted = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new BaseOS instance.
     *
     * @param config - Optional configuration
     */
    constructor(config?: OSConfig) {
        this.config = config ?? {};

        // Initialize aliases from config
        if (config?.aliases) {
            for (const [name, aliasPath] of Object.entries(config.aliases)) {
                this.aliases.set(name, aliasPath);
            }
        }
    }

    // =========================================================================
    // ABSTRACT METHODS
    // =========================================================================

    /**
     * Boot the OS.
     *
     * Subclasses implement this with their specific boot sequence:
     * - OS: Full linear boot with all subsystems
     * - TestOS: Flexible partial boot with HAL injection
     */
    abstract boot(opts?: unknown): Promise<void>;

    // =========================================================================
    // CONFIGURATION API
    // =========================================================================

    /**
     * Add or update a path alias.
     *
     * WHY: Enables '@app' -> '/vol/app' style shortcuts. Can be called
     * before or after boot.
     *
     * @param name - Alias name (e.g., '@app')
     * @param aliasPath - Target path (e.g., '/vol/app')
     * @returns this for chaining
     */
    alias(name: string, aliasPath: string): this {
        this.aliases.set(name, aliasPath);

        return this;
    }

    /**
     * Register a lifecycle event listener.
     *
     * @deprecated Lifecycle events are not currently supported.
     * @throws EINVAL always
     */
    on<K extends OSEventName>(_event: K, _callback: OSEvents[K]): this {
        throw new EINVAL('Lifecycle events not supported');
    }

    /**
     * Resolve a path, expanding any aliases.
     *
     * WHY: Centralizes alias expansion so all path-accepting methods
     * can support aliases uniformly.
     *
     * @param inputPath - Path that may contain an alias prefix
     * @returns Resolved path with alias expanded
     */
    resolvePath(inputPath: string): string {
        for (const [alias, target] of this.aliases) {
            if (inputPath === alias) {
                return target;
            }

            if (inputPath.startsWith(alias + '/')) {
                return target + inputPath.slice(alias.length);
            }
        }

        return inputPath;
    }

    // =========================================================================
    // SYSCALL API
    // =========================================================================

    /**
     * Get the init process for syscall context.
     *
     * WHY: External syscalls execute in the context of PID 1 (init).
     * This provides proper process identity for permission checks
     * and resource tracking.
     *
     * @throws EINVAL if OS not booted or init process not found
     */
    protected getInitProcess(): Process {
        if (!this.__kernel) {
            throw new EINVAL('OS not booted');
        }

        const init = this.__kernel.processes.getInit();

        if (!init) {
            throw new EINVAL('Init process not found');
        }

        return init;
    }

    /**
     * Make a syscall to the kernel.
     *
     * Low-level interface for direct kernel communication.
     * Executes in the context of the init process (PID 1).
     *
     * ALGORITHM:
     * 1. Get init process for syscall context
     * 2. Dispatch syscall through dispatcher
     * 3. Collect response stream into result
     * 4. Return single value (ok) or array (items)
     *
     * @param name - Syscall name (e.g., 'file:open', 'ems:select')
     * @param args - Syscall arguments
     * @returns Unwrapped result (single value or array of items)
     * @throws Error from syscall if response.op === 'error'
     *
     * @example
     * ```typescript
     * // Single-value syscall
     * const fd = await os.syscall<number>('file:open', '/etc/config.json', { read: true });
     *
     * // Streaming syscall (items collected into array)
     * const users = await os.syscall<User[]>('ems:select', 'User', { where: { active: true } });
     * ```
     */
    async syscall<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
        // SAFETY: getInitProcess() throws if not booted
        const init = this.getInitProcess();

        // SAFETY: __dispatcher is non-null when booted (INV-1)
        const stream = this.__dispatcher!.dispatch(init, name, args);

        // Collect response - handles both single-value and streaming syscalls
        const items: unknown[] = [];
        let singleResult: unknown = undefined;
        let hasOk = false;

        for await (const response of stream) {
            // RACE FIX: Check boot state after each await - shutdown could occur
            if (!this.booted) {
                throw new EINVAL('OS shutdown during syscall');
            }

            if (response.op === 'ok') {
                singleResult = response.data;
                hasOk = true;
                break;
            }

            if (response.op === 'item') {
                items.push(response.data);
                continue;
            }

            if (response.op === 'done') {
                break;
            }

            if (response.op === 'error') {
                const err = response.data as { code: string; message: string };

                throw fromCode(err.code, err.message);
            }

            // data, event, progress - collect for special cases
            if (response.op === 'data' && response.bytes) {
                items.push(response.bytes);
            }
        }

        // Return single value or collected items
        if (hasOk) {
            return singleResult as T;
        }

        return items as T;
    }

    /**
     * Make a syscall and return the raw response stream.
     *
     * WHY: Some syscalls need streaming (progress events, large data).
     * This method exposes the raw stream for full control.
     *
     * @param name - Syscall name
     * @param args - Syscall arguments
     * @returns AsyncIterable of Response objects
     */
    syscallStream(name: string, ...args: unknown[]): AsyncIterable<Response> {
        // SAFETY: getInitProcess() throws if not booted
        const init = this.getInitProcess();

        // SAFETY: __dispatcher is non-null when booted (INV-1)
        return this.__dispatcher!.dispatch(init, name, args);
    }

    // =========================================================================
    // DOMAIN SYSCALL WRAPPERS
    // =========================================================================

    /**
     * Entity Management System syscall.
     */
    async ems<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.syscall<T>(`ems:${method}`, ...args);
    }

    /**
     * Virtual File System syscall.
     */
    async vfs<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.syscall<T>(`file:${method}`, ...args);
    }

    /**
     * Process syscall.
     */
    async process<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.syscall<T>(`proc:${method}`, ...args);
    }

    // =========================================================================
    // SYSCALL ALIASES
    // =========================================================================

    /**
     * Alias for vfs() - file system operations.
     */
    file<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.vfs<T>(method, ...args);
    }

    /**
     * Alias for ems() - entity operations.
     */
    entity<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.ems<T>(method, ...args);
    }

    // =========================================================================
    // CONVENIENCE HELPERS
    // =========================================================================

    /**
     * Spawn a new process.
     */
    async spawn(
        cmd: string,
        opts?: { args?: string[]; env?: Record<string, string>; cwd?: string },
    ): Promise<number> {
        const resolved = this.resolvePath(cmd);

        return this.process<number>('spawn', resolved, opts);
    }

    /**
     * Kill a process.
     */
    async kill(pid: number, signal = 15): Promise<void> {
        return this.process<void>('kill', pid, signal);
    }

    /**
     * Mount a filesystem.
     */
    async mount(
        type: string,
        source: string,
        target: string,
        opts?: Record<string, unknown>,
    ): Promise<void> {
        const resolved = this.resolvePath(target);
        const fullSource = `${type}:${source}`;

        return this.syscall<void>('fs:mount', fullSource, resolved, opts);
    }

    /**
     * Unmount a filesystem.
     */
    async unmount(target: string): Promise<void> {
        const resolved = this.resolvePath(target);

        return this.syscall<void>('fs:umount', resolved);
    }

    /**
     * Copy from host filesystem to VFS.
     *
     * WHY: Enables copying ROM files and host directories into VFS
     * during boot or at runtime.
     *
     * @param hostSource - Source path on host filesystem
     * @param vfsTarget - Target path in VFS (aliases resolved)
     */
    async copy(hostSource: string, vfsTarget: string): Promise<void> {
        const resolved = this.resolvePath(vfsTarget);
        const stat = await fs.stat(hostSource);

        if (stat.isDirectory()) {
            await this.copyDir(hostSource, resolved);
        }
        else {
            await this.copyFile(hostSource, resolved);
        }
    }

    /**
     * Read a file as raw bytes.
     *
     * @param filePath - File path (aliases resolved)
     * @returns File contents as Uint8Array
     */
    async read(filePath: string): Promise<Uint8Array> {
        const resolved = this.resolvePath(filePath);
        const fd = await this.vfs<number>('open', resolved, { read: true });

        try {
            const chunks = await this.syscall<Uint8Array[]>('file:read', fd);

            if (chunks.length === 0) {
                return new Uint8Array(0);
            }

            if (chunks.length === 1) {
                return chunks[0]!;
            }

            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;

            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }

            return result;
        }
        finally {
            await this.vfs('close', fd);
        }
    }

    /**
     * Read a file as text.
     *
     * @param filePath - File path (aliases resolved)
     * @param encoding - Text encoding (default: 'utf-8')
     * @returns File contents as string
     */
    async text(filePath: string, encoding = 'utf-8'): Promise<string> {
        const bytes = await this.read(filePath);

        // WHY cast: TextDecoder accepts any valid encoding string, but TypeScript
        // has a strict Encoding type. We trust the caller to provide valid encodings.
        return new TextDecoder(encoding as 'utf-8').decode(bytes);
    }

    // =========================================================================
    // SERVICE MANAGEMENT
    // =========================================================================

    /**
     * Service management operations.
     *
     * WHY: Provides a high-level API for service lifecycle management
     * without requiring direct kernel access.
     *
     * @param action - Action to perform (start, stop, restart, status, list)
     * @param nameOrPid - Service name or PID (required for all except 'list')
     * @returns Action result
     */
    async service(action: string, nameOrPid?: string | number): Promise<unknown> {
        if (!this.__kernel) {
            throw new EINVAL('OS not booted');
        }

        // Import dynamically to avoid circular dependency
        const { activateService } = await import('@src/kernel/kernel/activate-service.js');
        const services = this.__kernel.getServices();

        switch (action) {
            case 'list':
                return Array.from(services.values());

            case 'status': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                const svc = services.get(String(nameOrPid));

                if (!svc) {
                    throw new EINVAL(`Service not found: ${nameOrPid}`);
                }

                return svc;
            }

            case 'start': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                const name = String(nameOrPid);
                const def = services.get(name);

                if (!def) {
                    throw new EINVAL(`Service not found: ${name}`);
                }

                // RACE: Check-then-act on activation state
                // WHY: Acceptable because activateService() is idempotent
                if (this.__kernel.activationPorts.has(name) || this.__kernel.activationAborts.has(name)) {
                    throw new EINVAL(`Service already running: ${name}`);
                }

                await activateService(this.__kernel, name, def);

                return { started: name };
            }

            case 'stop': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                const name = String(nameOrPid);

                const abort = this.__kernel.activationAborts.get(name);

                if (abort) {
                    abort.abort();
                    this.__kernel.activationAborts.delete(name);
                }

                const port = this.__kernel.activationPorts.get(name);

                if (port) {
                    await port.close();
                    this.__kernel.activationPorts.delete(name);
                }

                return { stopped: name };
            }

            case 'restart': {
                if (!nameOrPid) {
                    throw new EINVAL('Service name required');
                }

                await this.service('stop', nameOrPid);
                await this.service('start', nameOrPid);

                return { restarted: String(nameOrPid) };
            }

            default:
                throw new EINVAL(`Unknown service action: ${action}`);
        }
    }

    // =========================================================================
    // LIFECYCLE: SHUTDOWN
    // =========================================================================

    /**
     * Shutdown the OS gracefully.
     *
     * Shuts down subsystems in reverse boot order:
     * Gateway -> Kernel -> VFS -> Auth -> EMS -> HAL
     *
     * RACE CONDITION:
     * RC-2: Safe to call multiple times (idempotent via booted check).
     *
     * Works for any subset of initialized layers - TestOS may only have
     * partial subsystems initialized, so each is checked before shutdown.
     */
    async shutdown(): Promise<void> {
        // RC-2: Idempotent - safe to call if not booted
        if (!this.booted) {
            return;
        }

        // Mark as not booted first to fail any in-flight syscalls
        this.booted = false;

        // Shutdown in reverse order: Gateway -> Kernel -> VFS -> Auth -> EMS -> HAL
        if (this.__gateway) {
            await this.__gateway.shutdown();
            this.__gateway = null;
        }

        if (this.__kernel?.isBooted()) {
            await this.__kernel.shutdown();
        }

        this.__dispatcher = null;
        this.__kernel = null;

        if (this.__vfs) {
            await this.__vfs.shutdown();
            this.__vfs = null;
        }

        if (this.__auth) {
            await this.__auth.shutdown();
            this.__auth = null;
        }

        if (this.__ems) {
            await this.__ems.shutdown();
            this.__ems = null;
        }

        if (this.__hal) {
            await this.__hal.shutdown();
            this.__hal = null;
        }
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Check if the OS is booted.
     */
    isBooted(): boolean {
        return this.booted;
    }

    /**
     * Get the EntityOps instance (for EntityAPI).
     *
     * WHY: Used internally by EntityAPI class (src/os/ems.ts:102).
     * @throws EINVAL if OS not booted
     */
    getEntityOps(): EntityOps {
        if (!this.__ems) {
            throw new EINVAL('OS not booted');
        }

        return this.__ems.ops;
    }

    // =========================================================================
    // TESTING HELPERS
    // =========================================================================

    /**
     * Get count of registered aliases.
     *
     * TESTING: Allows tests to verify alias registration.
     */
    getAliasCount(): number {
        return this.aliases.size;
    }

    // =========================================================================
    // PROTECTED HELPERS
    // =========================================================================

    /**
     * Copy a single file from host to VFS.
     *
     * WHY: Uses VFS directly instead of syscalls to support being called
     * during boot before the kernel is initialized.
     */
    protected async copyFile(hostPath: string, vfsPath: string): Promise<void> {
        const vfsInst = this.__vfs;

        if (!vfsInst) {
            throw new EINVAL('VFS not initialized');
        }

        const parent = vfsPath.substring(0, vfsPath.lastIndexOf('/')) || '/';

        try {
            await vfsInst.stat(parent, 'kernel');
        }
        catch {
            await vfsInst.mkdir(parent, 'kernel', { recursive: true });
        }

        const content = await fs.readFile(hostPath);
        const handle = await vfsInst.open(
            vfsPath,
            { write: true, create: true, truncate: true },
            'kernel',
        );

        try {
            await handle.write(new Uint8Array(content));
        }
        finally {
            await handle.close();
        }
    }

    /**
     * Recursively copy a directory from host to VFS.
     *
     * WHY: Uses VFS directly instead of syscalls to support being called
     * during boot before the kernel is initialized.
     */
    protected async copyDir(hostPath: string, vfsPath: string): Promise<void> {
        const vfsInst = this.__vfs;

        if (!vfsInst) {
            throw new EINVAL('VFS not initialized');
        }

        try {
            await vfsInst.stat(vfsPath, 'kernel');
        }
        catch {
            try {
                await vfsInst.mkdir(vfsPath, 'kernel', { recursive: true });
            }
            catch (mkdirErr) {
                // EDGE: Directory may have been created by concurrent operation
                // or exists from previous boot. If it's EEXIST, check if it's a folder.
                if ((mkdirErr as NodeJS.ErrnoException).code === 'EEXIST') {
                    const existing = await vfsInst.stat(vfsPath, 'kernel');

                    if (existing.model !== 'folder') {
                        throw mkdirErr;
                    }
                    // It's a folder - continue
                }
                else {
                    throw mkdirErr;
                }
            }
        }

        const entries = await fs.readdir(hostPath, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(hostPath, entry.name);
            const dstPath = path.posix.join(vfsPath, entry.name);

            if (entry.isDirectory()) {
                await this.copyDir(srcPath, dstPath);
            }
            else if (entry.isFile()) {
                await this.copyFile(srcPath, dstPath);
            }
        }
    }
}
