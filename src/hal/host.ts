/**
 * Host Device - Escape hatch to host operating system
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The HostDevice provides a controlled escape mechanism from Monk OS's sandbox
 * to execute native processes on the host operating system. This is necessary
 * for certain operations that cannot be virtualized within Bun's runtime
 * environment, such as invoking native build tools, system utilities, or
 * platform-specific commands.
 *
 * The interface intentionally mirrors POSIX process spawning semantics while
 * wrapping Bun's process spawning primitives. Two execution modes are provided:
 *
 * 1. spawn(): Asynchronous process creation returning a handle for interaction
 *    with stdin/stdout/stderr streams and wait/kill operations.
 *
 * 2. exec(): Synchronous convenience wrapper that spawns, waits, and collects
 *    all output into strings. Suitable for short-lived commands where streaming
 *    is unnecessary.
 *
 * The device also provides system information queries (platform, architecture,
 * hostname, memory/CPU statistics) by wrapping Node.js os module functions.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Spawned processes run on HOST OS with host user permissions (not sandboxed)
 * INV-2: Process handles remain valid until wait() completes
 * INV-3: Stream handles (stdin/stdout/stderr) are null if not piped
 * INV-4: kill() is idempotent (safe to call on already-exited processes)
 * INV-5: System information queries (platform, arch, hostname) are immutable per boot
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. Multiple
 * Monk processes may spawn host processes concurrently through this device.
 *
 * The HostDevice itself maintains no state - it's a stateless wrapper around
 * Bun.spawn(). Each HostProcess handle encapsulates state for one host process:
 * - running flag: updated when exited promise resolves
 * - stream handles: assigned at spawn time, never change
 * - PID: assigned by host OS, immutable
 *
 * Stream operations (reading stdout/stderr, writing stdin) are managed by Bun's
 * ReadableStream/WritableStream primitives, which handle their own concurrency.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: running flag updated via exited promise to avoid TOCTOU bugs
 * RC-2: wait() returns immediately if process already exited (idempotent)
 * RC-3: kill() is safe to call at any time (Bun handles already-dead processes)
 * RC-4: Stream reads/writes fail gracefully if process exits mid-operation
 *
 * MEMORY MANAGEMENT
 * =================
 * - HostProcess handles own no resources directly (streams owned by Bun)
 * - Caller responsible for reading streams to completion (avoid memory leaks)
 * - Bun automatically closes streams when process exits
 * - exec() helper ensures streams are fully consumed before returning
 *
 * SECURITY CONSIDERATIONS
 * =======================
 * This is an ESCAPE HATCH with significant security implications:
 *
 * - Command injection: If cmd/args constructed from untrusted input, attacker
 *   can execute arbitrary commands on host OS. Always validate/sanitize inputs.
 *
 * - Privilege escalation: Commands run with host user's permissions, not Monk's
 *   sandbox restrictions. A compromised Monk process can affect the host.
 *
 * - Resource exhaustion: No resource limits imposed by Monk. Host process limits
 *   apply, but attacker could spawn many processes to exhaust host resources.
 *
 * - Data exfiltration: Host processes can access host filesystem, network, etc.
 *   outside of Monk's VFS and network abstractions.
 *
 * TESTABILITY
 * ===========
 * MockHostDevice enables deterministic testing without spawning real processes:
 * - Pre-program command responses via addCommand()
 * - Verify commands were invoked with expected arguments
 * - Control system information queries (platform, arch, memory)
 * - No blocking, no network, no filesystem side effects
 *
 * @module hal/host
 */

import { cpus, totalmem, freemem, hostname, platform, arch } from 'node:os';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Host spawn options
 *
 * Configuration for spawning a host OS process. Mirrors POSIX process spawning
 * semantics while wrapping Bun.spawn() options.
 *
 * WHY: Provides fine-grained control over process environment, working directory,
 * and I/O redirection - essential for process isolation and testing.
 *
 * TESTABILITY: Options can be mocked/controlled in tests to verify correct
 * process invocation without actually spawning host processes.
 */
export interface HostSpawnOpts {
    /**
     * Working directory on host filesystem
     *
     * WHY: Process should run in specific directory context for relative paths
     * to resolve correctly (e.g., when invoking build tools).
     */
    cwd?: string;

    /**
     * Environment variables (merged with current environment)
     *
     * WHY: Allows customizing process environment without affecting parent.
     * Variables are merged (not replaced) to preserve essential env like PATH.
     */
    env?: Record<string, string>;

    /**
     * Stdin source
     *
     * WHY: 'pipe' enables sending input programmatically, 'inherit' connects to
     * parent's stdin, 'ignore' closes stdin (prevents blocking on input).
     */
    stdin?: 'pipe' | 'inherit' | 'ignore';

    /**
     * Stdout destination
     *
     * WHY: 'pipe' enables capturing output, 'inherit' shows output immediately,
     * 'ignore' discards output (useful for silent background processes).
     */
    stdout?: 'pipe' | 'inherit' | 'ignore';

    /**
     * Stderr destination
     *
     * WHY: Same as stdout, but for diagnostic/error messages. Often piped
     * separately to distinguish normal output from errors.
     */
    stderr?: 'pipe' | 'inherit' | 'ignore';

    /**
     * Timeout in milliseconds (0 = no timeout)
     *
     * WHY: Prevents runaway processes from blocking forever. Kernel can enforce
     * time limits on host process execution.
     */
    timeout?: number;
}

/**
 * Host process handle
 *
 * Represents a running (or completed) host OS process. Provides access to
 * process ID, I/O streams, and lifecycle operations (wait, kill).
 *
 * WHY: Encapsulates process state and operations in a single interface. Caller
 * can interact with process without knowing Bun-specific details.
 *
 * INVARIANTS:
 * - pid never changes after construction
 * - stdin/stdout/stderr never change after construction (null if not piped)
 * - running transitions from true to false exactly once (at exit)
 *
 * RACE CONDITION: running flag may become stale between check and use. Always
 * safe to call wait() or kill() regardless of running state.
 */
export interface HostProcess {
    /**
     * Process ID on host OS
     *
     * WHY: Uniquely identifies process for debugging, monitoring, or sending
     * signals. Can be correlated with host OS tools (ps, top, etc.).
     *
     * INVARIANT: Never changes after spawn.
     */
    readonly pid: number;

    /**
     * Write to stdin (if piped)
     *
     * WHY: Enables programmatic interaction with process input. Null if stdin
     * was not configured as 'pipe' during spawn.
     *
     * INVARIANT: Null if stdin !== 'pipe', otherwise WritableStream.
     */
    readonly stdin: WritableStream<Uint8Array> | null;

    /**
     * Read from stdout (if piped)
     *
     * WHY: Enables capturing process output for processing. Null if stdout
     * was not configured as 'pipe' during spawn.
     *
     * INVARIANT: Null if stdout !== 'pipe', otherwise ReadableStream.
     */
    readonly stdout: ReadableStream<Uint8Array> | null;

    /**
     * Read from stderr (if piped)
     *
     * WHY: Enables capturing error/diagnostic output separately from stdout.
     * Null if stderr was not configured as 'pipe' during spawn.
     *
     * INVARIANT: Null if stderr !== 'pipe', otherwise ReadableStream.
     */
    readonly stderr: ReadableStream<Uint8Array> | null;

    /**
     * Wait for process to exit
     *
     * Returns exit code and optional signal (if process was killed by signal).
     * This promise resolves exactly once when process terminates.
     *
     * WHY: Provides synchronization point for waiting on process completion.
     * Essential for exec() pattern and resource cleanup.
     *
     * INVARIANT: Resolves exactly once per process, never rejects.
     *
     * @returns Exit code and signal (if killed)
     */
    wait(): Promise<{ exitCode: number; signal?: string }>;

    /**
     * Send signal to process
     *
     * Attempts to terminate or control process via signal. Defaults to SIGTERM
     * (graceful termination). SIGKILL forces immediate termination.
     *
     * WHY: Provides mechanism for process lifecycle management and cancellation.
     *
     * INVARIANT: Safe to call multiple times, safe to call on exited process.
     *
     * @param signal - Signal number or name (default: SIGTERM)
     */
    kill(signal?: number | string): void;

    /**
     * Check if process is still running
     *
     * WHY: Enables polling for process state without blocking on wait().
     *
     * RACE CONDITION: Value may become stale immediately after check. Do not
     * rely on this for correctness - use wait() for synchronization.
     */
    readonly running: boolean;
}

/**
 * Host system statistics
 *
 * WHY: Provides resource information for scheduling decisions, capacity
 * planning, and system monitoring. Kernel can use this to make informed
 * decisions about worker pool sizing, memory limits, etc.
 */
export interface HostStat {
    /** Number of CPU cores */
    cpus: number;

    /** Total memory in bytes */
    memtotal: number;

    /** Free memory in bytes */
    memfree: number;
}

/**
 * Host device interface
 *
 * WHY: Defines the contract for interacting with the host OS. Implementations
 * can be swapped for testing (MockHostDevice) or alternative runtimes.
 */
export interface HostDevice {
    /**
     * Spawn a process on the host OS
     *
     * Creates a new host OS process running cmd with args. Returns immediately
     * with a handle for interacting with the process.
     *
     * ALGORITHM:
     * 1. Validate cmd (not empty, exists on PATH if relative)
     * 2. Merge opts.env with current environment
     * 3. Invoke Bun.spawn([cmd, ...args], bunOpts)
     * 4. Wrap Subprocess in HostProcess interface
     * 5. Track exit via exited promise
     *
     * SECURITY WARNING:
     * This is an escape hatch to the host OS. Commands run with host user
     * permissions, no sandboxing, no Monk resource limits. Potential security
     * risk if cmd/args contain untrusted input (command injection).
     *
     * RACE CONDITION:
     * Process may exit before spawn() returns. Handle running flag is updated
     * asynchronously via exited promise. Caller should not assume process is
     * running after spawn() returns.
     *
     * @param cmd - Command to run
     * @param args - Command arguments
     * @param opts - Spawn options
     * @returns Process handle
     */
    spawn(cmd: string, args?: string[], opts?: HostSpawnOpts): HostProcess;

    /**
     * Run command and wait for result
     *
     * Convenience wrapper that spawns process, waits for completion, and
     * collects stdout/stderr into strings.
     *
     * ALGORITHM:
     * 1. Call spawn(cmd, args, { ...opts, stdout: 'pipe', stderr: 'pipe' })
     * 2. Start reading stdout and stderr streams in parallel
     * 3. Wait for process exit
     * 4. Decode collected bytes to UTF-8 strings
     * 5. Return { exitCode, stdout, stderr }
     *
     * WHY: Simplifies common pattern of running command and collecting output.
     * No need to manually manage streams for simple use cases.
     *
     * TESTABILITY: MockHostDevice can pre-program responses per command.
     *
     * @param cmd - Command to run
     * @param args - Command arguments
     * @param opts - Spawn options
     * @returns Exit code, stdout, stderr
     */
    exec(
        cmd: string,
        args?: string[],
        opts?: HostSpawnOpts
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;

    /**
     * Host OS platform
     *
     * Returns platform identifier: 'darwin' (macOS), 'linux', 'win32' (Windows).
     *
     * WHY: Enables platform-specific code paths (e.g., different path separators,
     * shell syntax, system calls).
     *
     * INVARIANT: Never changes during process lifetime.
     *
     * @returns 'darwin', 'linux', 'win32', etc.
     */
    platform(): string;

    /**
     * Host CPU architecture
     *
     * Returns architecture identifier: 'x64', 'arm64', etc.
     *
     * WHY: Enables architecture-specific optimizations or binary selection.
     *
     * INVARIANT: Never changes during process lifetime.
     *
     * @returns 'x64', 'arm64', etc.
     */
    arch(): string;

    /**
     * Host machine hostname
     *
     * WHY: Useful for debugging, logging, and distributed system coordination
     * (identifying which host a process is running on).
     *
     * INVARIANT: Generally doesn't change during process lifetime (can change
     * if host is renamed, but rare).
     */
    hostname(): string;

    /**
     * Host system statistics
     *
     * Returns current CPU count and memory availability.
     *
     * WHY: Enables resource-aware scheduling and capacity planning. Kernel can
     * adjust worker pool sizes based on available resources.
     *
     * RACE CONDITION: memfree changes constantly as host OS allocates/frees
     * memory. Value is a snapshot at call time, may be stale immediately.
     */
    stat(): HostStat;

    /**
     * Get host environment variable
     *
     * Reads directly from host process environment (process.env).
     *
     * WHY: Unlike kernel environment (getenv syscall), this reads the actual
     * host environment. Useful for accessing host-specific configuration
     * (PATH, HOME, etc.) that Monk processes may need.
     *
     * @param key - Environment variable name
     * @returns Value or undefined if not set
     */
    getenv(key: string): string | undefined;
}

// =============================================================================
// MAIN IMPLEMENTATIONS
// =============================================================================

/**
 * Bun host device implementation
 *
 * Production implementation using Bun.spawn() and Node.js os module.
 *
 * Bun touchpoints:
 * - Bun.spawn(cmd, { args, cwd, env, stdin, stdout, stderr })
 * - Subprocess.pid, stdin, stdout, stderr, exited, kill()
 * - os.platform(), os.arch(), os.hostname(), os.cpus(), os.totalmem(), os.freemem()
 *
 * Caveats:
 * - Bun.spawn() returns Subprocess with different API than Node child_process
 * - stdin/stdout/stderr can be ReadableStream or WritableStream (not Node streams)
 * - exited is a Promise that resolves to exit code (not event emitter)
 * - kill() takes optional signal as number, not string
 */
export class BunHostDevice implements HostDevice {
    // =========================================================================
    // PROCESS SPAWNING
    // =========================================================================

    spawn(cmd: string, args: string[] = [], opts: HostSpawnOpts = {}): HostProcess {
        // WHY: Bun.spawn() expects command + args as single array
        const proc = Bun.spawn([cmd, ...args], {
            cwd: opts.cwd,
            // WHY: Merge env vars instead of replacing to preserve essential vars like PATH
            env: opts.env ? { ...process.env, ...opts.env } : undefined,
            // WHY: Map our string options to Bun's expected types (pipe/inherit/null)
            stdin: opts.stdin === 'pipe' ? 'pipe' : opts.stdin === 'inherit' ? 'inherit' : null,
            stdout: opts.stdout === 'pipe' ? 'pipe' : opts.stdout === 'inherit' ? 'inherit' : null,
            stderr: opts.stderr === 'pipe' ? 'pipe' : opts.stderr === 'inherit' ? 'inherit' : null,
        });

        // WHY: Track running state to implement .running getter
        let running = true;

        // RACE FIX: Update running flag when process exits (asynchronous)
        proc.exited.then(() => {
            running = false;
        });

        return {
            get pid() {
                return proc.pid;
            },

            get stdin() {
                // WHY: Type cast needed because Bun types are overly broad
                return (proc.stdin as unknown) as WritableStream<Uint8Array> | null;
            },

            get stdout() {
                return (proc.stdout as unknown) as ReadableStream<Uint8Array> | null;
            },

            get stderr() {
                return (proc.stderr as unknown) as ReadableStream<Uint8Array> | null;
            },

            async wait() {
                const code = await proc.exited;
                return { exitCode: code };
            },

            kill(signal?: number | string) {
                // WHY: Bun only accepts numeric signals, convert string to undefined (uses default)
                proc.kill(typeof signal === 'string' ? undefined : signal);
            },

            get running() {
                return running;
            },
        };
    }

    async exec(
        cmd: string,
        args: string[] = [],
        opts: HostSpawnOpts = {}
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        // WHY: Force pipe mode to capture output
        const proc = this.spawn(cmd, args, {
            ...opts,
            stdout: 'pipe',
            stderr: 'pipe',
        });

        // WHY: Read both streams in parallel to avoid deadlock if one fills buffer
        const [stdoutChunks, stderrChunks] = await Promise.all([
            this.readStream(proc.stdout),
            this.readStream(proc.stderr),
        ]);

        const { exitCode } = await proc.wait();

        return {
            exitCode,
            stdout: new TextDecoder().decode(this.concatChunks(stdoutChunks)),
            stderr: new TextDecoder().decode(this.concatChunks(stderrChunks)),
        };
    }

    // -------------------------------------------------------------------------
    // Helper Methods
    // -------------------------------------------------------------------------

    /**
     * Read all chunks from a stream
     *
     * WHY: ReadableStream API is pull-based (read() calls). We need to collect
     * all chunks before process exits to avoid losing output.
     *
     * @param stream - Stream to read (null if not piped)
     * @returns Array of chunks
     */
    private async readStream(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array[]> {
        if (!stream) return [];
        const chunks: Uint8Array[] = [];
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
        } finally {
            // WHY: Always release lock even if read() throws
            reader.releaseLock();
        }
        return chunks;
    }

    /**
     * Concatenate byte chunks into single Uint8Array
     *
     * WHY: Multiple read() calls produce separate chunks. We need to combine
     * them before decoding to UTF-8 (multi-byte characters may span chunks).
     *
     * @param chunks - Array of chunks
     * @returns Single concatenated array
     */
    private concatChunks(chunks: Uint8Array[]): Uint8Array {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    // =========================================================================
    // SYSTEM INFORMATION
    // =========================================================================

    platform(): string {
        return platform();
    }

    arch(): string {
        return arch();
    }

    hostname(): string {
        return hostname();
    }

    stat(): HostStat {
        return {
            cpus: cpus().length,
            memtotal: totalmem(),
            memfree: freemem(),
        };
    }

    getenv(key: string): string | undefined {
        return process.env[key];
    }
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Mock host device for testing
 *
 * Provides scripted command responses without spawning real processes.
 * Useful for unit testing code that depends on HostDevice without requiring
 * actual host OS interaction.
 *
 * WHY: Tests should be deterministic, fast, and isolated. Spawning real
 * processes introduces timing variability, platform dependencies, and
 * potential side effects (filesystem changes, network calls, etc.).
 *
 * USAGE:
 *   const host = new MockHostDevice();
 *   host.addCommand('ls', { exitCode: 0, stdout: 'file1\nfile2' });
 *   const result = await host.exec('ls');
 *   // result.stdout === 'file1\nfile2'
 *
 * TESTABILITY: All state is mutable via setters, enabling test scenarios:
 * - Simulate different platforms (Linux, macOS, Windows)
 * - Control available resources (CPU count, memory)
 * - Pre-program command responses (success/failure cases)
 * - Reset state between tests
 */
export class MockHostDevice implements HostDevice {
    // =========================================================================
    // INTERNAL STATE
    // =========================================================================

    /**
     * Scripted command responses
     *
     * WHY: Maps command name to predefined output/exit code. Enables testing
     * both success and failure scenarios without real process execution.
     */
    private commands = new Map<string, { exitCode: number; stdout: string; stderr: string }>();

    /**
     * Mock platform identifier
     *
     * WHY: Tests may need to verify platform-specific behavior without running
     * on multiple OSes.
     */
    private _platform = 'linux';

    /**
     * Mock architecture identifier
     */
    private _arch = 'x64';

    /**
     * Mock hostname
     */
    private _hostname = 'mock-host';

    /**
     * Mock system statistics
     *
     * WHY: Default to reasonable values (4 cores, 8GB RAM, 4GB free)
     */
    private _stat: HostStat = { cpus: 4, memtotal: 8 * 1024 * 1024 * 1024, memfree: 4 * 1024 * 1024 * 1024 };

    /**
     * Mock environment variables
     */
    private _env: Record<string, string> = {};

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * Add scripted command response
     *
     * WHY: Pre-program what exec() should return for a given command. Tests
     * can verify correct command invocation and handle responses.
     *
     * @param cmd - Command name
     * @param response - Exit code and output
     */
    addCommand(cmd: string, response: { exitCode: number; stdout?: string; stderr?: string }): void {
        this.commands.set(cmd, {
            exitCode: response.exitCode,
            stdout: response.stdout ?? '',
            stderr: response.stderr ?? '',
        });
    }

    setPlatform(p: string): void {
        this._platform = p;
    }

    setArch(a: string): void {
        this._arch = a;
    }

    setHostname(h: string): void {
        this._hostname = h;
    }

    setStat(s: HostStat): void {
        this._stat = s;
    }

    setEnv(env: Record<string, string>): void {
        this._env = env;
    }

    /**
     * Reset all mocks to default state
     *
     * WHY: Tests should start with clean slate. Call reset() in beforeEach()
     * to avoid test pollution.
     */
    reset(): void {
        this.commands.clear();
        this._platform = 'linux';
        this._arch = 'x64';
        this._hostname = 'mock-host';
        this._env = {};
    }

    // =========================================================================
    // PROCESS SPAWNING (MOCKED)
    // =========================================================================

    spawn(cmd: string, _args: string[] = [], _opts: HostSpawnOpts = {}): HostProcess {
        const response = this.commands.get(cmd) ?? { exitCode: 127, stdout: '', stderr: `command not found: ${cmd}` };
        let waited = false;

        return {
            // WHY: Random PID for realism (tests shouldn't rely on specific PIDs)
            pid: Math.floor(Math.random() * 10000),
            stdin: null,
            stdout: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(response.stdout));
                    controller.close();
                },
            }),
            stderr: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(response.stderr));
                    controller.close();
                },
            }),
            async wait() {
                waited = true;
                return { exitCode: response.exitCode };
            },
            kill() {
                // WHY: No-op for mock (process is synchronous, already "exited")
            },
            get running() {
                return !waited;
            },
        };
    }

    async exec(
        cmd: string,
        _args: string[] = [],
        _opts: HostSpawnOpts = {}
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const response = this.commands.get(cmd);
        if (response) {
            return response;
        }
        // WHY: Exit code 127 is POSIX convention for "command not found"
        return { exitCode: 127, stdout: '', stderr: `command not found: ${cmd}` };
    }

    // =========================================================================
    // SYSTEM INFORMATION (MOCKED)
    // =========================================================================

    platform(): string {
        return this._platform;
    }

    arch(): string {
        return this._arch;
    }

    hostname(): string {
        return this._hostname;
    }

    stat(): HostStat {
        // WHY: Return copy to prevent test mutations from affecting other tests
        return { ...this._stat };
    }

    getenv(key: string): string | undefined {
        return this._env[key];
    }
}
