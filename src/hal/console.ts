/**
 * Console Device - Raw console I/O for kernel logging and early boot output
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Console Device provides low-level access to stdin/stdout/stderr for kernel
 * logging, early boot messages, and raw I/O before the VFS is available. It sits
 * at the bottom of the HAL stack and has no dependencies on other subsystems.
 *
 * Three I/O streams are supported:
 * - stdin (read/readline): Input from the console, typically user keyboard input
 * - stdout (write): Standard output for normal program messages and kernel logs
 * - stderr (error): Standard error for warnings, errors, and diagnostic output
 *
 * The interface provides both raw byte I/O (read/write) and line-based I/O
 * (readline). Line-based input handles platform newline differences (LF vs CRLF)
 * and buffers partial lines until a complete line is available.
 *
 * The device also reports TTY status (isTTY). This is critical for deciding
 * whether to use ANSI colors, progress bars, or interactive prompts. Non-TTY
 * contexts (pipes, files, CI) should use plain text output.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: read() returns empty Uint8Array on EOF, never null/undefined
 * INV-2: readline() returns null on EOF, string otherwise (never throws on EOF)
 * INV-3: write/error never throw on success (may throw on system errors)
 * INV-4: isTTY() is stable for the lifetime of the device (no mid-execution changes)
 * INV-5: readline() strips trailing CR LF regardless of platform
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded, but async operations can interleave. Multiple
 * calls to read() or readline() may be in flight concurrently. The device
 * serializes these internally:
 *
 * - read() creates a stdin reader on first call and reuses it
 * - readline() buffers data internally and yields complete lines
 * - write/error are synchronous and atomic (though may buffer in OS)
 *
 * Multiple processes may call console methods via syscalls. The kernel serializes
 * syscalls through the event loop, so console calls execute one at a time from
 * the kernel's perspective.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Stdin reader is created lazily and cached (no double-initialization)
 * RC-2: readline() buffer state is isolated to the device instance
 * RC-3: write/error are synchronous - no await points where state can change
 * RC-4: isTTY() reads immutable process.stdout.isTTY (no TOCTOU)
 *
 * MEMORY MANAGEMENT
 * =================
 * - stdin reader is created once and held for device lifetime
 * - readline() maintains internal buffer that grows as data arrives
 * - Buffer is trimmed after each complete line is consumed
 * - No explicit cleanup needed - reader and buffer are GC'd with device
 * - Mock implementation accumulates output for test inspection
 *
 * @module hal/console
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Console device interface.
 *
 * WHY: Provides abstraction for testability and portability. Tests can inject
 * mock console devices with predefined input and captured output. Alternative
 * implementations can redirect to files, network sockets, or GUI widgets.
 */
export interface ConsoleDevice {
    /**
     * Read from stdin.
     *
     * Bun implementation: Bun.stdin.stream().getReader().read()
     *
     * WHY async: stdin is a stream that may block waiting for input. Making
     * this async allows the event loop to continue while waiting for data.
     *
     * CAVEAT: Blocks until data available or EOF. For interactive input with
     * editing and line discipline, consider using the TTY subsystem instead.
     * This is raw stream reading - no echo, no editing, no Ctrl-C handling.
     *
     * ERROR HANDLING: Returns empty Uint8Array on EOF, never throws. Stream
     * errors (unlikely) propagate as exceptions.
     *
     * @returns Input bytes (empty on EOF)
     */
    read(): Promise<Uint8Array>;

    /**
     * Read a single line from stdin.
     *
     * Bun implementation: Buffers read() data until newline found
     *
     * WHY: Line-oriented input is very common (REPL, prompts, config parsing).
     * Handling newlines and buffering is complex and error-prone - better to
     * do it once in the device.
     *
     * WHY strip trailing CR: Handles both Unix (LF) and Windows (CRLF) line
     * endings transparently. Caller gets clean line text without platform-specific
     * newline handling.
     *
     * CAVEAT: Buffers internally until newline found. For very long lines
     * without newlines, memory usage grows. Consider read() for binary or
     * unbounded input.
     *
     * @returns Line without trailing newline, or null on EOF
     */
    readline(): Promise<string | null>;

    /**
     * Write to stdout.
     *
     * Bun implementation: process.stdout.write()
     *
     * WHY synchronous: Writes are fast (usually buffered by OS). Making them
     * async adds complexity without benefit. If backpressure becomes an issue,
     * batching writes is more effective than making individual writes async.
     *
     * CAVEAT: Synchronous call. For high-volume output, may cause backpressure.
     * Consider batching writes or using streams for large data transfers.
     *
     * ERROR HANDLING: May throw on system errors (EPIPE if stdout closed, ENOSPC
     * if disk full). Caller should handle these errors.
     *
     * @param data - Bytes to write
     */
    write(data: Uint8Array): void;

    /**
     * Write to stderr.
     *
     * Bun implementation: process.stderr.write()
     *
     * WHY separate from write: stderr is typically unbuffered and may be
     * redirected separately from stdout. Keeping them separate matches POSIX
     * and allows proper separation of logs vs output.
     *
     * @param data - Bytes to write
     */
    error(data: Uint8Array): void;

    /**
     * Check if stdout is a TTY.
     *
     * Bun implementation: process.stdout.isTTY
     *
     * WHY: Critical for deciding output formatting. TTY supports ANSI colors,
     * cursor movement, and interactive prompts. Non-TTY (pipes, files, CI)
     * should use plain text.
     *
     * USE CASES:
     * - Enable colors only if isTTY()
     * - Show progress bars only if isTTY()
     * - Use interactive prompts only if isTTY()
     * - Adjust line buffering based on TTY status
     *
     * @returns true if stdout is a terminal, false if pipe/file/null
     */
    isTTY(): boolean;
}

// =============================================================================
// MAIN IMPLEMENTATION
// =============================================================================

/**
 * Bun console device implementation
 *
 * Bun touchpoints:
 * - process.stdout.write(data) - Write to stdout (sync)
 * - process.stderr.write(data) - Write to stderr (sync)
 * - Bun.stdin.stream() - Get readable stream for stdin
 * - stream.getReader() - Get stream reader (WHATWG Streams API)
 * - reader.read() - Read chunk from stdin (async)
 * - process.stdout.isTTY - Check if TTY
 *
 * WHY these APIs: Bun provides WHATWG Streams API for stdin (modern, standard)
 * and Node.js-compatible stdout/stderr (familiar, synchronous). This combination
 * gives us async input and sync output, which matches typical usage patterns.
 *
 * Caveats:
 * - Bun.stdin is a ReadableStream (WHATWG), not Node.js Readable
 * - For line reading, we buffer data internally until newline appears
 * - stdin reader is created once and reused (WHATWG readers lock the stream)
 * - write() is synchronous but may buffer internally in the OS
 * - In non-TTY contexts (pipes), behavior differs from interactive terminals
 *
 * TESTABILITY: Interface allows dependency injection of mock implementations.
 */
export class BunConsoleDevice implements ConsoleDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Stdin stream reader.
     *
     * WHY any type: Bun's stream reader types are complex and involve
     * ReadableStreamDefaultReader<Uint8Array>. Using 'any' simplifies the code
     * without losing safety (we only call read() which is well-typed).
     *
     * WHY lazy initialization: Reader locks the stream, so we only create it
     * when first needed. Most processes never read stdin.
     *
     * WHY cache: WHATWG stream readers lock the stream. We can't create multiple
     * readers, so we must reuse this one.
     *
     * RACE CONDITION: Checked and created atomically (no await between check
     * and creation). Once created, never null.
     */
    private stdinReader: any = null;

    /**
     * Internal buffer for line reading.
     *
     * WHY: readline() must buffer data until a complete line (ending with LF)
     * is available. We accumulate chunks from read() here until we find LF.
     *
     * WHY Uint8Array: Works with binary data, no encoding assumptions until
     * we decode the line.
     *
     * INVARIANT: Contains only data that hasn't been returned from readline yet.
     * After returning a line, we trim the buffer to remove consumed data.
     *
     * MEMORY: Grows as data arrives, shrinks after each line. For interactive
     * input, typically stays small (a few bytes). For large pastes or pipe
     * input, can grow to line length.
     */
    private stdinBuffer: Uint8Array = new Uint8Array(0);

    // =========================================================================
    // INPUT OPERATIONS
    // =========================================================================

    /**
     * Read raw bytes from stdin.
     *
     * ALGORITHM:
     * 1. Get or create stdin reader (lazy init)
     * 2. Call reader.read() to get next chunk
     * 3. If done or no value, return empty array (EOF)
     * 4. Otherwise, wrap value in Uint8Array and return
     *
     * WHY wrap in Uint8Array: Bun returns ArrayBuffer or Uint8Array. Wrapping
     * ensures consistent return type.
     *
     * RACE CONDITION: None - reader is created once and cached. No concurrent
     * modifications to reader state.
     *
     * @returns Data chunk or empty array on EOF
     */
    async read(): Promise<Uint8Array> {
        // Get or create reader
        if (!this.stdinReader) {
            this.stdinReader = Bun.stdin.stream().getReader();
        }

        const { value, done } = await this.stdinReader.read();
        if (done || !value) {
            return new Uint8Array(0);
        }
        return new Uint8Array(value);
    }

    /**
     * Read a line from stdin.
     *
     * ALGORITHM:
     * 1. Loop until we have a complete line or EOF:
     *    a. Check buffer for newline (byte 10 = LF)
     *    b. If found:
     *       - Extract line from buffer (up to LF)
     *       - Remove line + LF from buffer
     *       - Strip trailing CR if present (Windows CRLF)
     *       - Return line
     *    c. If not found:
     *       - Read more data from stdin
     *       - If EOF and buffer not empty, return remaining buffer as line
     *       - If EOF and buffer empty, return null
     *       - Otherwise, append data to buffer and continue
     *
     * WHY loop: We may need multiple read() calls to get a complete line,
     * especially for interactive input where user types slowly.
     *
     * WHY check buffer first: Previous read() may have returned multiple lines.
     * We need to consume buffered lines before reading more data.
     *
     * WHY strip CR: Windows uses CRLF (\\r\\n), Unix uses LF (\\n). Stripping
     * CR handles both transparently. Caller gets clean line text.
     *
     * RACE CONDITION: Buffer is instance-local, no concurrent access possible.
     * Multiple readline() calls will queue on the read() calls.
     *
     * @returns Line text or null on EOF
     */
    async readline(): Promise<string | null> {
        const decoder = new TextDecoder();

        while (true) {
            // Check buffer for newline
            const newlineIndex = this.stdinBuffer.indexOf(10); // '\\n'
            if (newlineIndex !== -1) {
                const line = decoder.decode(this.stdinBuffer.slice(0, newlineIndex));
                this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
                // Remove trailing \\r if present (Windows line endings)
                return line.replace(/\r$/, '');
            }

            // Read more data
            const chunk = await this.read();
            if (chunk.length === 0) {
                // EOF - return remaining buffer if any
                if (this.stdinBuffer.length > 0) {
                    const line = decoder.decode(this.stdinBuffer);
                    this.stdinBuffer = new Uint8Array(0);
                    return line;
                }
                return null;
            }

            // Append to buffer
            const newBuffer = new Uint8Array(this.stdinBuffer.length + chunk.length);
            newBuffer.set(this.stdinBuffer);
            newBuffer.set(chunk, this.stdinBuffer.length);
            this.stdinBuffer = newBuffer;
        }
    }

    // =========================================================================
    // OUTPUT OPERATIONS
    // =========================================================================

    /**
     * Write to stdout.
     *
     * WHY synchronous: Node.js and Bun provide sync write for simplicity.
     * Making it async would require managing write queues and backpressure,
     * which is rarely needed. The OS handles buffering.
     *
     * ERROR HANDLING: May throw EPIPE (stdout closed), ENOSPC (disk full),
     * or other system errors. Caller should handle these.
     *
     * @param data - Bytes to write
     */
    write(data: Uint8Array): void {
        process.stdout.write(data);
    }

    /**
     * Write to stderr.
     *
     * WHY separate: stderr is typically unbuffered (line-buffered at most) and
     * may be redirected separately. Keeping it separate matches POSIX and
     * enables proper log/output separation.
     *
     * @param data - Bytes to write
     */
    error(data: Uint8Array): void {
        process.stderr.write(data);
    }

    // =========================================================================
    // TTY DETECTION
    // =========================================================================

    /**
     * Check if stdout is a TTY.
     *
     * WHY check stdout not stdin: We care about output formatting. Stdout being
     * a TTY means we can use colors, cursor movement, etc. Stdin TTY status is
     * separate (matters for input handling).
     *
     * WHY ?? false: process.stdout.isTTY may be undefined in some contexts
     * (e.g., worker threads). Default to false (conservative - assume not a TTY).
     *
     * @returns true if stdout is a terminal
     */
    isTTY(): boolean {
        return process.stdout.isTTY ?? false;
    }
}

// =============================================================================
// TESTING UTILITIES
// =============================================================================

/**
 * Buffer console device for testing
 *
 * WHY: Essential for testing console-dependent code without actual console I/O.
 * Tests can:
 * - Provide canned input via setInput()
 * - Capture and assert on output via getOutput()
 * - Simulate TTY or non-TTY environments
 * - Run in parallel without I/O conflicts
 *
 * DESIGN: Accumulates all output in memory for later inspection. Provides
 * canned input that read() consumes. Simulates TTY status for format testing.
 *
 * TESTABILITY: Enables deterministic, fast, parallel tests of console I/O code.
 *
 * Usage:
 *   const console = new BufferConsoleDevice();
 *   console.setInput('hello\\nworld\\n');
 *   const line = await console.readline(); // 'hello'
 *   console.write(new TextEncoder().encode('output'));
 *   assert(console.getOutput() === 'output');
 */
export class BufferConsoleDevice implements ConsoleDevice {
    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Canned input data.
     *
     * WHY: Simulates stdin for testing. Tests set this via setInput() and
     * read() consumes it sequentially.
     */
    private input: Uint8Array = new Uint8Array(0);

    /**
     * Current read position in input.
     *
     * WHY: Tracks how much of input has been consumed by read(). When inputPos
     * reaches input.length, we're at EOF.
     */
    private inputPos = 0;

    /**
     * Captured stdout output chunks.
     *
     * WHY array of chunks: Preserves write boundaries for tests that care about
     * chunking. Can be flattened to single string via getOutput().
     */
    private output: Uint8Array[] = [];

    /**
     * Captured stderr output chunks.
     *
     * WHY separate from stdout: Tests often need to verify error messages
     * separately from normal output.
     */
    private errors: Uint8Array[] = [];

    /**
     * Simulated TTY status.
     *
     * WHY: Allows tests to verify TTY-dependent behavior (colors, formatting).
     */
    private tty = false;

    // =========================================================================
    // CONTROL METHODS (testing only)
    // =========================================================================

    /**
     * Set input data that will be returned by read().
     *
     * WHY: Allows tests to provide canned input without actual stdin. Tests
     * can simulate user input, file contents, or specific byte patterns.
     *
     * @param data - Input data (string or bytes)
     */
    setInput(data: string | Uint8Array): void {
        this.input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        this.inputPos = 0;
    }

    /**
     * Get all captured stdout output as string.
     *
     * WHY: Simplifies test assertions. Most tests just want to verify text
     * output, not individual chunks or byte arrays.
     *
     * @returns All stdout output concatenated
     */
    getOutput(): string {
        const total = this.output.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this.output) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return new TextDecoder().decode(result);
    }

    /**
     * Get all captured stderr output as string.
     *
     * WHY: Allows tests to verify error/warning messages separately from
     * normal output.
     *
     * @returns All stderr output concatenated
     */
    getErrors(): string {
        const total = this.errors.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this.errors) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return new TextDecoder().decode(result);
    }

    /**
     * Clear captured output.
     *
     * WHY: Allows tests to reset state between test cases without creating
     * new instances.
     *
     * TESTABILITY: Enables test isolation - each test can start with clean state.
     */
    reset(): void {
        this.input = new Uint8Array(0);
        this.inputPos = 0;
        this.output = [];
        this.errors = [];
    }

    /**
     * Set whether to report as TTY.
     *
     * WHY: Allows tests to verify TTY-dependent behavior (colors, interactive
     * prompts) and non-TTY behavior (plain text, batch mode).
     *
     * @param isTTY - true to simulate TTY, false for non-TTY
     */
    setTTY(isTTY: boolean): void {
        this.tty = isTTY;
    }

    // =========================================================================
    // CONSOLEDEVICE IMPLEMENTATION
    // =========================================================================

    /**
     * Read from simulated stdin.
     *
     * ALGORITHM:
     * 1. If inputPos >= input.length, return empty array (EOF)
     * 2. Otherwise, return all remaining input
     * 3. Advance inputPos to end
     *
     * WHY return all remaining: Simpler than chunking. Real stdin may return
     * data in variable-sized chunks, but for testing we can return it all at once.
     *
     * @returns Remaining input or empty array on EOF
     */
    async read(): Promise<Uint8Array> {
        if (this.inputPos >= this.input.length) {
            return new Uint8Array(0);
        }

        // Return remaining input
        const result = this.input.slice(this.inputPos);
        this.inputPos = this.input.length;
        return result;
    }

    /**
     * Read line from simulated stdin.
     *
     * ALGORITHM:
     * 1. If at EOF, return null
     * 2. Find newline in remaining input
     * 3. If found, return line up to newline and advance position
     * 4. If not found, return remaining input as line and advance to EOF
     *
     * WHY simpler than BunConsoleDevice: No need to buffer across multiple
     * read() calls - all input is available immediately.
     *
     * @returns Line text or null on EOF
     */
    async readline(): Promise<string | null> {
        if (this.inputPos >= this.input.length) {
            return null;
        }

        const remaining = this.input.slice(this.inputPos);
        const newlineIndex = remaining.indexOf(10);

        if (newlineIndex === -1) {
            this.inputPos = this.input.length;
            return new TextDecoder().decode(remaining);
        }

        const line = new TextDecoder().decode(remaining.slice(0, newlineIndex));
        this.inputPos += newlineIndex + 1;
        return line.replace(/\r$/, '');
    }

    /**
     * Capture stdout write.
     *
     * WHY slice: Copy the data to prevent mutation. Caller might reuse the
     * buffer after writing.
     *
     * @param data - Bytes to write
     */
    write(data: Uint8Array): void {
        this.output.push(data.slice()); // Copy to prevent mutation
    }

    /**
     * Capture stderr write.
     *
     * @param data - Bytes to write
     */
    error(data: Uint8Array): void {
        this.errors.push(data.slice());
    }

    /**
     * Get simulated TTY status.
     *
     * @returns Configured TTY status
     */
    isTTY(): boolean {
        return this.tty;
    }
}
