/**
 * Host Device
 *
 * Escape hatch to the host operating system.
 * Use sparingly - prefer kernel-level abstractions.
 *
 * Bun touchpoints:
 * - Bun.spawn() for process spawning
 * - Bun.spawnSync() for synchronous execution
 * - os module equivalents via process
 *
 * Caveats:
 * - Spawned processes run on HOST OS, not in Monk OS sandbox
 * - Security: command injection if args not sanitized
 * - Blocking: spawnSync blocks event loop
 * - Platform differences: path separators, shell behavior
 * - Resource limits: HOST process limits, not Monk limits
 */

import { cpus, totalmem, freemem, hostname, platform, arch } from 'node:os';

/**
 * Host spawn options
 */
export interface HostSpawnOpts {
    /** Working directory on host filesystem */
    cwd?: string;
    /** Environment variables (merged with current) */
    env?: Record<string, string>;
    /** Stdin source */
    stdin?: 'pipe' | 'inherit' | 'ignore';
    /** Stdout destination */
    stdout?: 'pipe' | 'inherit' | 'ignore';
    /** Stderr destination */
    stderr?: 'pipe' | 'inherit' | 'ignore';
    /** Timeout in milliseconds (0 = no timeout) */
    timeout?: number;
}

/**
 * Host process handle
 */
export interface HostProcess {
    /** Process ID on host OS */
    readonly pid: number;

    /** Write to stdin (if piped) */
    readonly stdin: WritableStream<Uint8Array> | null;

    /** Read from stdout (if piped) */
    readonly stdout: ReadableStream<Uint8Array> | null;

    /** Read from stderr (if piped) */
    readonly stderr: ReadableStream<Uint8Array> | null;

    /**
     * Wait for process to exit.
     *
     * @returns Exit code and signal (if killed)
     */
    wait(): Promise<{ exitCode: number; signal?: string }>;

    /**
     * Send signal to process.
     *
     * @param signal - Signal number or name (default: SIGTERM)
     */
    kill(signal?: number | string): void;

    /**
     * Check if process is still running.
     */
    readonly running: boolean;
}

/**
 * Host system statistics
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
 * Host device interface.
 */
export interface HostDevice {
    /**
     * Spawn a process on the host OS.
     *
     * Bun: Bun.spawn()
     *
     * WARNING: This is an escape hatch to the host OS.
     * - Commands run with host user permissions
     * - No sandboxing or resource limits from Monk
     * - Potential security risk if args not validated
     *
     * @param cmd - Command to run
     * @param args - Command arguments
     * @param opts - Spawn options
     * @returns Process handle
     */
    spawn(cmd: string, args?: string[], opts?: HostSpawnOpts): HostProcess;

    /**
     * Run command and wait for result.
     *
     * Bun: Bun.spawnSync() equivalent via spawn + wait
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
     * Host OS platform.
     *
     * Node: os.platform()
     *
     * @returns 'darwin', 'linux', 'win32', etc.
     */
    platform(): string;

    /**
     * Host CPU architecture.
     *
     * Node: os.arch()
     *
     * @returns 'x64', 'arm64', etc.
     */
    arch(): string;

    /**
     * Host machine hostname.
     *
     * Node: os.hostname()
     */
    hostname(): string;

    /**
     * Host system statistics.
     *
     * Node: os.cpus(), os.totalmem(), os.freemem()
     */
    stat(): HostStat;

    /**
     * Get host environment variable.
     *
     * Unlike EnvDevice, this reads directly from host.
     */
    getenv(key: string): string | undefined;
}

/**
 * Bun host device implementation
 *
 * Bun touchpoints:
 * - Bun.spawn(cmd, { args, cwd, env, stdin, stdout, stderr })
 * - os module for system info
 *
 * Caveats:
 * - Bun.spawn() returns a Subprocess with different API than Node
 * - stdin/stdout/stderr can be ReadableStream or WritableStream
 */
export class BunHostDevice implements HostDevice {
    spawn(cmd: string, args: string[] = [], opts: HostSpawnOpts = {}): HostProcess {
        const proc = Bun.spawn([cmd, ...args], {
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : undefined,
            stdin: opts.stdin === 'pipe' ? 'pipe' : opts.stdin === 'inherit' ? 'inherit' : null,
            stdout: opts.stdout === 'pipe' ? 'pipe' : opts.stdout === 'inherit' ? 'inherit' : null,
            stderr: opts.stderr === 'pipe' ? 'pipe' : opts.stderr === 'inherit' ? 'inherit' : null,
        });

        let running = true;
        let exitResult: { exitCode: number; signal?: string } | null = null;

        // Track when process exits
        proc.exited.then((code) => {
            running = false;
            exitResult = { exitCode: code };
        });

        return {
            get pid() {
                return proc.pid;
            },

            get stdin() {
                return proc.stdin as WritableStream<Uint8Array> | null;
            },

            get stdout() {
                return proc.stdout as ReadableStream<Uint8Array> | null;
            },

            get stderr() {
                return proc.stderr as ReadableStream<Uint8Array> | null;
            },

            async wait() {
                const code = await proc.exited;
                return { exitCode: code };
            },

            kill(signal?: number | string) {
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
        const proc = this.spawn(cmd, args, {
            ...opts,
            stdout: 'pipe',
            stderr: 'pipe',
        });

        // Read stdout and stderr
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
            reader.releaseLock();
        }
        return chunks;
    }

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

/**
 * Mock host device for testing
 *
 * Provides scripted command responses.
 *
 * Usage:
 *   const host = new MockHostDevice();
 *   host.addCommand('ls', { exitCode: 0, stdout: 'file1\nfile2' });
 *   const result = await host.exec('ls');
 *   // result.stdout === 'file1\nfile2'
 */
export class MockHostDevice implements HostDevice {
    private commands = new Map<string, { exitCode: number; stdout: string; stderr: string }>();
    private _platform = 'linux';
    private _arch = 'x64';
    private _hostname = 'mock-host';
    private _stat: HostStat = { cpus: 4, memtotal: 8 * 1024 * 1024 * 1024, memfree: 4 * 1024 * 1024 * 1024 };
    private _env: Record<string, string> = {};

    /**
     * Add scripted command response.
     */
    addCommand(cmd: string, response: { exitCode: number; stdout?: string; stderr?: string }): void {
        this.commands.set(cmd, {
            exitCode: response.exitCode,
            stdout: response.stdout ?? '',
            stderr: response.stderr ?? '',
        });
    }

    /**
     * Set mock platform.
     */
    setPlatform(p: string): void {
        this._platform = p;
    }

    /**
     * Set mock architecture.
     */
    setArch(a: string): void {
        this._arch = a;
    }

    /**
     * Set mock hostname.
     */
    setHostname(h: string): void {
        this._hostname = h;
    }

    /**
     * Set mock system stats.
     */
    setStat(s: HostStat): void {
        this._stat = s;
    }

    /**
     * Set mock environment.
     */
    setEnv(env: Record<string, string>): void {
        this._env = env;
    }

    /**
     * Reset all mocks.
     */
    reset(): void {
        this.commands.clear();
        this._platform = 'linux';
        this._arch = 'x64';
        this._hostname = 'mock-host';
        this._env = {};
    }

    spawn(cmd: string, args: string[] = [], _opts: HostSpawnOpts = {}): HostProcess {
        const response = this.commands.get(cmd) ?? { exitCode: 127, stdout: '', stderr: `command not found: ${cmd}` };
        let waited = false;

        return {
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
                // No-op for mock
            },
            get running() {
                return !waited;
            },
        };
    }

    async exec(
        cmd: string,
        args: string[] = [],
        opts: HostSpawnOpts = {}
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const response = this.commands.get(cmd);
        if (response) {
            return response;
        }
        return { exitCode: 127, stdout: '', stderr: `command not found: ${cmd}` };
    }

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
        return { ...this._stat };
    }

    getenv(key: string): string | undefined {
        return this._env[key];
    }
}
