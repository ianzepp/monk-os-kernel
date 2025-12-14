/**
 * TestOS - Flexible OS implementation for testing
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * TestOS extends BaseOS with a flexible boot sequence that supports:
 * - Partial layer initialization (only boot what you need)
 * - HAL injection (use existing HAL instance)
 * - Skip ROM/init for faster tests
 * - Direct subsystem access via internal* getters
 *
 * This enables tests to boot only the layers they need, reducing test
 * overhead and avoiding spaghetti mock factories.
 *
 * LAYER DEPENDENCIES
 * ==================
 * gateway -> dispatcher -> kernel -> vfs -> auth -> ems -> hal
 *
 * Requesting a layer automatically includes its dependencies.
 * For example, `{ layers: ['vfs'] }` implies hal, ems, auth, vfs.
 *
 * USAGE EXAMPLES
 * ==============
 * ```typescript
 * // Full boot (default)
 * const os = new TestOS();
 * await os.boot();
 *
 * // VFS-only testing (no kernel, no gateway)
 * const os = new TestOS();
 * await os.boot({ layers: ['vfs'] });
 *
 * // Inject existing HAL
 * const os = new TestOS();
 * await os.boot({ hal: myHal });
 *
 * // Direct subsystem access
 * const vfs = os.internalVfs;
 * ```
 *
 * @module os/test
 */

import type { HAL } from '@src/hal/index.js';
import { BunHAL } from '@src/hal/index.js';
import { VFS } from '@src/vfs/vfs.js';
import { Kernel } from '@src/kernel/kernel.js';
import { EMS } from '@src/ems/ems.js';
import { Auth } from '@src/auth/index.js';
import { SyscallDispatcher } from '@src/dispatch/index.js';
import { Gateway } from '@src/gateway/index.js';
import type { DatabaseConnection } from '@src/hal/connection.js';
import type { FileDevice } from '@src/hal/file.js';
import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { BaseOS } from './base.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Layers that can be selectively initialized.
 *
 * Dependencies cascade automatically:
 * - gateway -> dispatcher -> kernel -> vfs -> auth -> ems -> hal
 */
export type TestLayer = 'hal' | 'ems' | 'auth' | 'vfs' | 'kernel' | 'dispatcher' | 'gateway';

/**
 * Init options for TestOS.
 *
 * Allows flexible partial initialization for testing.
 */
export interface TestInitOpts {
    /**
     * Inject existing HAL instance.
     *
     * WHY: Allows tests to share a HAL or use a pre-configured one.
     * The injected HAL will NOT be shut down by TestOS.
     */
    hal?: HAL;

    /**
     * Layers to initialize.
     *
     * WHY: Tests often only need VFS or EMS, not the full stack.
     * Dependencies cascade automatically - requesting 'kernel'
     * will also initialize hal, ems, auth, vfs.
     *
     * Default: all layers (full init)
     */
    layers?: TestLayer[];

    /**
     * Skip ROM copy.
     *
     * WHY: ROM copy is slow and unnecessary for most unit tests.
     * Default: true (skip)
     */
    skipRom?: boolean;
}

/**
 * Boot options for TestOS.
 *
 * For backwards compatibility, boot() also accepts TestInitOpts.
 * If layers are specified in boot(), it will call init() first.
 */
export interface TestBootOpts extends TestInitOpts {
    /**
     * Skip service activation during boot.
     *
     * WHY: Many tests don't need services running.
     * Default: true (skip)
     */
    skipServices?: boolean;
}

// =============================================================================
// VFS SCHEMA HELPERS
// =============================================================================

/**
 * Path to VFS schema file relative to this module.
 *
 * WHY: After schema split, VFS tables are no longer in EMS core schema.
 * Tests that manually set up EMS components need to load VFS schema
 * if they use VFS models (file, folder, device, proc, link, temp).
 */
const VFS_SCHEMA_PATH = new URL('../vfs/schema.sql', import.meta.url).pathname;

/**
 * Load VFS schema into database.
 *
 * WHY: Tests that use VFS models but set up EMS manually need this.
 *
 * @param db - Database connection
 * @param hal - HAL instance for file reading
 */
export async function loadVfsSchema(db: DatabaseConnection, hal: HAL): Promise<void> {
    const schema = await hal.file.readText(VFS_SCHEMA_PATH);

    await db.exec(schema);
}

/**
 * Load VFS schema into database using FileDevice directly.
 *
 * WHY: Variant for tests that use FileDevice instead of full HAL.
 *
 * @param db - Database connection
 * @param fileDevice - FileDevice for reading schema file
 */
export async function loadVfsSchemaWithFileDevice(db: DatabaseConnection, fileDevice: FileDevice): Promise<void> {
    const schema = await fileDevice.readText(VFS_SCHEMA_PATH);

    await db.exec(schema);
}

// =============================================================================
// MAIN CLASS
// =============================================================================

/**
 * TestOS - Flexible OS for testing.
 *
 * Provides partial boot capability and direct subsystem access
 * for efficient testing without mock factories.
 */
export class TestOS extends BaseOS {
    /**
     * Whether we own the HAL (should shut it down).
     *
     * WHY: When HAL is injected via init({ hal }), we don't own it
     * and shouldn't shut it down. Only shut down HAL we created.
     */
    private ownsHal = true;

    /**
     * Track which layers were initialized for boot() logic.
     */
    private initLayers: TestLayer[] = [];

    // =========================================================================
    // LIFECYCLE: INIT
    // =========================================================================

    /**
     * Initialize TestOS with flexible layer selection.
     *
     * ALGORITHM:
     * 1. Determine which layers are needed (cascade dependencies)
     * 2. Initialize each needed layer in order
     * 3. Mark as initialized
     *
     * @param opts - Init options for layer selection and HAL injection
     */
    async init(opts?: TestInitOpts): Promise<void> {
        // Default to full init if no layers specified
        const layers = opts?.layers ?? ['hal', 'ems', 'auth', 'vfs', 'kernel', 'dispatcher', 'gateway'];
        this.initLayers = layers;

        // Cascade dependencies: gateway -> dispatcher -> kernel -> vfs -> auth -> ems -> hal
        const needGateway = layers.includes('gateway');
        const needDispatcher = layers.includes('dispatcher') || needGateway;
        const needKernel = layers.includes('kernel') || needDispatcher;
        const needVfs = layers.includes('vfs') || needKernel;
        const needAuth = layers.includes('auth') || needVfs;
        const needEms = layers.includes('ems') || needAuth;
        const needHal = layers.includes('hal') || needEms || !!opts?.hal;

        // =====================================================================
        // HAL Layer
        // =====================================================================
        if (needHal) {
            if (opts?.hal) {
                // Use injected HAL (don't shut it down later)
                this.__hal = opts.hal;
                this.ownsHal = false;
            }
            else {
                // Create in-memory HAL for testing
                this.__hal = new BunHAL({ storage: { type: 'memory' } });
                await this.__hal.init();
                this.ownsHal = true;
            }
        }

        // =====================================================================
        // EMS Layer
        // =====================================================================
        if (needEms && this.__hal) {
            this.__ems = new EMS(this.__hal);
            await this.__ems.init();
        }

        // =====================================================================
        // Auth Layer
        // =====================================================================
        if (needAuth && this.__hal && this.__ems) {
            // WHY allowAnonymous: Test code shouldn't need to authenticate
            this.__auth = new Auth(this.__hal, this.__ems, { allowAnonymous: true });
            await this.__auth.init();
        }

        // =====================================================================
        // VFS Layer
        // =====================================================================
        if (needVfs && this.__hal && this.__ems) {
            this.__vfs = new VFS(this.__hal, this.__ems);
            await this.__vfs.init();
        }

        // =====================================================================
        // Kernel + Dispatcher Layers
        // =====================================================================
        if (needKernel && this.__hal && this.__ems && this.__vfs) {
            this.__kernel = new Kernel(this.__hal, this.__ems, this.__vfs);

            if (needDispatcher) {
                this.__dispatcher = new SyscallDispatcher(
                    this.__kernel,
                    this.__vfs,
                    this.__ems,
                    this.__hal,
                    this.__auth ?? undefined,
                    undefined, // LLM
                );

                // Wire dispatcher to kernel
                this.__kernel.onWorkerMessage = (worker, msg) =>
                    this.__dispatcher!.onWorkerMessage(worker, msg);
            }

            // Copy ROM unless skipped
            const skipRom = opts?.skipRom ?? true;

            if (!skipRom) {
                try {
                    await this.copy('./rom', '/');
                }
                catch {
                    // EDGE: ROM may not exist in test environment
                }
            }

            // Initialize kernel (mounts /proc, loads services, creates PID 1 placeholder)
            await this.__kernel.init();
        }

        // =====================================================================
        // Gateway Layer
        // =====================================================================
        if (needGateway && this.__dispatcher && this.__kernel && this.__hal) {
            this.__gateway = new Gateway(this.__dispatcher, this.__kernel, this.__hal);
            // Use port 0 (auto-assign) for test isolation
            await this.__gateway.listen(0);
        }

        this.initialized = true;
    }

    // =========================================================================
    // LIFECYCLE: BOOT
    // =========================================================================

    /**
     * Boot TestOS (activate services).
     *
     * Most tests don't need this - init() is sufficient for syscall testing.
     * Call boot() only if you need services to be activated.
     *
     * For backwards compatibility, boot() also accepts init options (layers, hal, skipRom).
     * If not already initialized, it will call init() first with those options.
     *
     * @param opts - Boot options (also accepts init options for backwards compat)
     */
    async boot(opts?: TestBootOpts): Promise<void> {
        if (!this.initialized) {
            // For backwards compatibility, init with provided options
            await this.init(opts);
        }

        if (this.booted) {
            return;
        }

        // Boot kernel if it was initialized and services are wanted
        const skipServices = opts?.skipServices ?? true;

        if (this.__kernel?.isInitialized() && !skipServices) {
            await this.__kernel.boot();
        }

        this.booted = true;
    }

    // =========================================================================
    // LIFECYCLE: SHUTDOWN
    // =========================================================================

    /**
     * Shutdown TestOS.
     *
     * WHY: Overrides BaseOS.shutdown() to handle HAL ownership.
     * Only shuts down HAL if we created it (ownsHal === true).
     */
    override async shutdown(): Promise<void> {
        if (!this.initialized) {
            return;
        }

        this.initialized = false;
        this.booted = false;

        // Shutdown in reverse order, only what was initialized
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

        // Only shutdown HAL if we own it
        if (this.ownsHal && this.__hal) {
            await this.__hal.shutdown();
        }

        this.__hal = null;
    }

    // =========================================================================
    // INTERNAL ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get the Hardware Abstraction Layer.
     *
     * WHY: Direct access for test assertions and setup.
     * @throws Error if HAL not booted
     */
    get internalHal(): HAL {
        if (!this.__hal) {
            throw new Error('HAL not booted');
        }

        return this.__hal;
    }

    /**
     * Get the Entity Management System.
     *
     * WHY: Direct access for test assertions and setup.
     * @throws Error if EMS not booted
     */
    get internalEms(): EMS {
        if (!this.__ems) {
            throw new Error('EMS not booted');
        }

        return this.__ems;
    }

    /**
     * Get the Authentication subsystem.
     *
     * WHY: Direct access for test assertions and setup.
     * @throws Error if Auth not booted
     */
    get internalAuth(): Auth {
        if (!this.__auth) {
            throw new Error('Auth not booted');
        }

        return this.__auth;
    }

    /**
     * Get the Virtual File System.
     *
     * WHY: Direct access for test assertions and setup.
     * @throws Error if VFS not booted
     */
    get internalVfs(): VFS {
        if (!this.__vfs) {
            throw new Error('VFS not booted');
        }

        return this.__vfs;
    }

    /**
     * Get the Process Kernel.
     *
     * WHY: Direct access for test assertions and setup.
     * @throws Error if Kernel not booted
     */
    get internalKernel(): Kernel {
        if (!this.__kernel) {
            throw new Error('Kernel not booted');
        }

        return this.__kernel;
    }

    /**
     * Get the Syscall Dispatcher.
     *
     * WHY: Direct access for test assertions and setup.
     * @throws Error if Dispatcher not booted
     */
    get internalDispatcher(): SyscallDispatcher {
        if (!this.__dispatcher) {
            throw new Error('Dispatcher not booted');
        }

        return this.__dispatcher;
    }

    /**
     * Get the Gateway.
     *
     * WHY: Direct access for test assertions and setup.
     * @throws Error if Gateway not booted
     */
    get internalGateway(): Gateway {
        if (!this.__gateway) {
            throw new Error('Gateway not booted');
        }

        return this.__gateway;
    }

    // =========================================================================
    // SYSCALL TESTING SUPPORT
    // =========================================================================

    /**
     * Virtual test process for syscall testing.
     *
     * WHY: Allows syscall tests without spawning a real init process.
     * Created lazily on first syscall invocation.
     */
    private testProcess: Process | null = null;

    /**
     * Create a virtual process for syscall testing.
     *
     * WHY: Syscall handlers require a Process object for identity and state.
     * This creates a minimal virtual process that works for testing without
     * spawning a real worker.
     *
     * @param user - User identity for ACL checks (default: 'test')
     */
    private createTestProcess(user = 'test'): Process {
        return {
            id: crypto.randomUUID(),
            parent: '',
            user,
            worker: null as unknown as Worker,
            virtual: true,
            state: 'running',
            cmd: '/test',
            cwd: '/',
            env: {},
            args: [],
            pathDirs: new Map(),
            handles: new Map(),
            nextHandle: 3,
            children: new Map(),
            nextPid: 1,
            activeStreams: new Map(),
            streamPingHandlers: new Map(),
        };
    }

    /**
     * Get or create the test process.
     *
     * WHY: Reuses the same test process across syscalls for consistency.
     * The process is created lazily on first use.
     */
    getTestProcess(): Process {
        if (!this.testProcess) {
            this.testProcess = this.createTestProcess();
        }

        return this.testProcess;
    }

    /**
     * Execute a syscall for testing.
     *
     * WHY: Override of BaseOS.syscall() that works without init process.
     * Uses a virtual test process for syscall dispatch, enabling syscall
     * tests without full kernel boot.
     *
     * @param name - Syscall name (e.g., 'file:stat')
     * @param args - Syscall arguments
     * @returns Syscall result
     * @throws Error with code from syscall (e.g., EINVAL, ENOENT)
     */
    override async syscall<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
        if (!this.__dispatcher) {
            throw new Error('Dispatcher not booted');
        }

        // WHY: Use test process instead of init process
        // This enables syscall testing without spawning a real worker
        const proc = this.getTestProcess();

        const stream = this.__dispatcher.dispatch(proc, name, args);

        // Collect response - same logic as BaseOS.syscall()
        const items: unknown[] = [];
        let singleResult: unknown = undefined;
        let hasOk = false;

        for await (const response of stream) {
            if (response.op === 'error') {
                const error = new Error((response.data as { message?: string }).message ?? 'Syscall error');

                (error as Error & { code: string }).code = (response.data as { code: string }).code;
                throw error;
            }

            if (response.op === 'ok') {
                hasOk = true;
                singleResult = response.data;
            }
            else if (response.op === 'item') {
                items.push(response.data);
            }
        }

        // WHY: Return items array for streaming syscalls, single result otherwise
        if (items.length > 0) {
            return items as T;
        }

        if (hasOk) {
            return singleResult as T;
        }

        return undefined as T;
    }

    /**
     * Execute a streaming syscall for testing.
     *
     * WHY: Override of BaseOS.syscallStream() that works without init process.
     * Returns raw response stream for tests that need to inspect individual
     * responses (item, done, error).
     *
     * @param name - Syscall name (e.g., 'file:readdir')
     * @param args - Syscall arguments
     * @returns Async iterable of responses
     */
    override syscallStream(name: string, ...args: unknown[]): AsyncIterable<Response> {
        if (!this.__dispatcher) {
            throw new Error('Dispatcher not booted');
        }

        // WHY: Use test process instead of init process
        const proc = this.getTestProcess();

        return this.__dispatcher.dispatch(proc, name, args);
    }

    /**
     * Set the user identity for test syscalls.
     *
     * WHY: Some syscalls check user identity for ACL. Tests may need to
     * simulate different users.
     *
     * @param user - User identity (e.g., 'root', 'alice', 'kernel')
     */
    setTestUser(user: string): void {
        const proc = this.getTestProcess();

        proc.user = user;
    }

    /**
     * Set the working directory for test syscalls.
     *
     * WHY: Some syscalls resolve relative paths against cwd. Tests may
     * need to simulate different working directories.
     *
     * @param cwd - Working directory path
     */
    setTestCwd(cwd: string): void {
        const proc = this.getTestProcess();

        proc.cwd = cwd;
    }
}
