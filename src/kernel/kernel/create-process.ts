/**
 * Process Creation - Create process object with default state
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Creates a new Process object in 'starting' state. This is the first step in
 * process lifecycle, before worker creation and registration. The process
 * remains in 'starting' state until the worker is created and ready.
 *
 * STATE MACHINE
 * =============
 * This function creates a process in 'starting' state:
 *   [new] --> starting --> running --> stopped --> zombie --> [reaped]
 *             ^^^^^^^
 *             Created here
 *
 * INVARIANTS
 * ==========
 * INV-1: Process has valid UUID from entropy device
 *        VIOLATED BY: Entropy device failure (catastrophic)
 * INV-2: Process inherits environment from parent (if parent exists)
 *        VIOLATED BY: Passing null env when parent has env
 * INV-3: Process starts with 3 reserved file descriptors (0, 1, 2)
 *        VIOLATED BY: Modifying nextHandle to < 3
 * INV-4: Process state is 'starting' until worker is ready
 *        VIOLATED BY: Setting state before worker is created
 * INV-5: Process has no worker until spawnWorker completes
 *        VIOLATED BY: Accessing worker before it's set
 *
 * CONCURRENCY MODEL
 * =================
 * This function is synchronous and creates an in-memory object. No race
 * conditions exist because:
 * 1. UUID generation is atomic via HAL entropy device
 * 2. No async operations occur
 * 3. Process is not yet registered (not visible to other code)
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * This function runs in the main kernel thread and prepares state before
 * the worker thread is created.
 *
 * MEMORY MANAGEMENT
 * =================
 * Process object holds references to:
 * - Parent ID (string, not reference - prevents circular refs)
 * - Handle map (file descriptors) - cleaned up in exit/forceExit
 * - Child map (PID to UUID) - cleaned up when children exit
 * - Stream maps (for backpressure) - cleaned up in forceExit
 *
 * @module kernel/kernel/create-process
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';

/**
 * Create a new Process object in 'starting' state.
 *
 * WHY SEPARATE FROM SPAWN: Allows testing process creation without workers.
 * WHY PARENT ID NOT REF: Prevents circular references and memory leaks.
 * WHY CWD INHERITANCE: Child processes inherit parent's working directory.
 * WHY ENV MERGE: Parent env is base, child opts override specific values.
 *
 * ALGORITHM:
 * 1. Generate unique UUID for process identity
 * 2. Set parent ID (empty string for init process)
 * 3. Initialize worker to null (set later by spawnWorker)
 * 4. Set state to 'starting' (transitions to 'running' when worker ready)
 * 5. Merge environment variables (parent base + child overrides)
 * 6. Initialize file descriptor table (starts at 3, 0-2 reserved)
 * 7. Initialize child process map (PID namespace)
 * 8. Initialize stream management maps (for backpressure)
 *
 * @param self - Kernel instance (provides HAL for UUID generation)
 * @param opts - Process creation options
 * @param opts.parent - Parent process (undefined for init)
 * @param opts.cmd - Command path (entry point)
 * @param opts.cwd - Working directory (inherits from parent if unset)
 * @param opts.env - Environment variables (merged with parent)
 * @param opts.args - Command arguments (defaults to [cmd])
 * @returns New Process object in 'starting' state
 */
export function createProcess(
    self: Kernel,
    opts: {
        parent?: Process;
        cmd: string;
        cwd?: string;
        env?: Record<string, string>;
        args?: string[];
    },
): Process {
    return {
        // =====================================================================
        // IDENTITY
        // =====================================================================

        /**
         * Globally unique process identifier (UUID v4).
         * WHY UUID: Allows distributed process tracking across multiple kernels.
         * INVARIANT: Must be unique across all processes in the system.
         */
        id: self.hal.entropy.uuid(),

        /**
         * Parent process UUID (empty string for init).
         * WHY STRING: Prevents circular references (parent holds child ref).
         * INVARIANT: Must match a valid process ID or be empty.
         */
        parent: opts.parent?.id ?? '',

        // =====================================================================
        // WORKER THREAD
        // =====================================================================

        /**
         * Bun Worker instance (null until spawnWorker completes).
         * WHY NULL: Worker is created asynchronously, this placeholder ensures
         * TypeScript doesn't complain about undefined.
         * RACE FIX: Must check state='running' before accessing worker.
         */
        worker: null as unknown as Worker,

        /**
         * Process lifecycle state.
         * WHY STARTING: Process is not yet ready to receive syscalls.
         * TRANSITIONS: starting -> running -> stopped -> zombie
         */
        state: 'starting',

        // =====================================================================
        // EXECUTION CONTEXT
        // =====================================================================

        /**
         * Command path (entry point).
         * WHY: Identifies the executable, used for logging and debugging.
         */
        cmd: opts.cmd,

        /**
         * Current working directory.
         * WHY INHERIT: Child processes start in parent's directory by default.
         * FALLBACK: Root directory (/) if no parent.
         */
        cwd: opts.cwd ?? opts.parent?.cwd ?? '/',

        /**
         * Environment variables.
         * WHY MERGE: Parent env is base, child opts override specific keys.
         * WHY COPY: Prevents child from mutating parent's environment.
         */
        env: opts.parent ? { ...opts.parent.env, ...opts.env } : (opts.env ?? {}),

        /**
         * Command arguments.
         * WHY DEFAULT: argv[0] is traditionally the command name.
         */
        args: opts.args ?? [opts.cmd],

        /**
         * PATH directories as named entries (sorted by key).
         * WHY MAP: Allows named entries with priority ordering (00-core, 50-pkg).
         * WHY INHERIT: Child processes inherit parent's PATH by default.
         * DEFAULT: /bin for root processes.
         */
        pathDirs: opts.parent
            ? new Map(opts.parent.pathDirs)
            : new Map([['00-bin', '/bin']]),

        // =====================================================================
        // FILE DESCRIPTOR MANAGEMENT
        // =====================================================================

        /**
         * File descriptor to handle ID mapping.
         * WHY MAP: O(1) lookup from small integer fd to UUID handle ID.
         * INVARIANT: Keys are integers 0-255, values are handle UUIDs.
         */
        handles: new Map(),

        /**
         * Next available file descriptor number.
         * WHY 3: 0=recv, 1=send, 2=warn are reserved for stdio.
         * INVARIANT: Must never be less than 3.
         */
        nextHandle: 3,

        // =====================================================================
        // CHILD PROCESS MANAGEMENT
        // =====================================================================

        /**
         * PID to child process UUID mapping (PID namespace).
         * WHY MAP: Each process maintains its own PID namespace.
         * INVARIANT: PIDs are unique within this parent only.
         */
        children: new Map(),

        /**
         * Next PID to assign to child process.
         * WHY 1: PID 0 has special meaning in some contexts, start at 1.
         * INVARIANT: Monotonically increasing within this process.
         */
        nextPid: 1,

        // =====================================================================
        // STREAM BACKPRESSURE MANAGEMENT
        // =====================================================================

        /**
         * Active syscall streams (syscall ID -> abort controller).
         * WHY: Allows kernel to abort streams when process is killed.
         * MEMORY: Cleared in forceExit to prevent leaks.
         */
        activeStreams: new Map(),

        /**
         * Stream ping handlers (syscall ID -> timeout ID).
         * WHY: Tracks stream_ping timeouts to detect dead processes.
         * MEMORY: Cleared in forceExit to prevent leaks.
         */
        streamPingHandlers: new Map(),
    };
}
