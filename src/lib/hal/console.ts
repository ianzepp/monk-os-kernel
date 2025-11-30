/**
 * Console Device
 *
 * Raw console I/O for kernel logging and early boot output.
 *
 * Bun touchpoints:
 * - process.stdout for standard output
 * - process.stderr for standard error
 * - process.stdin for standard input
 * - Bun.stdin for async stdin reading
 *
 * Caveats:
 * - process.stdout.write() is synchronous but may buffer
 * - process.stdin requires raw mode for character-by-character input
 * - stdin.read() blocks the event loop; prefer async iteration
 * - In non-TTY contexts (pipes), behavior differs from interactive
 */

/**
 * Console device interface.
 */
export interface ConsoleDevice {
    /**
     * Read from stdin.
     *
     * Bun: Bun.stdin.text() or stream reading
     *
     * Caveat: Blocks until data available or EOF. For interactive
     * input, consider using the TTY subsystem instead.
     *
     * @returns Input bytes (empty on EOF)
     */
    read(): Promise<Uint8Array>;

    /**
     * Read a single line from stdin.
     *
     * Bun: Reads until newline or EOF
     *
     * @returns Line without trailing newline, or null on EOF
     */
    readline(): Promise<string | null>;

    /**
     * Write to stdout.
     *
     * Bun: process.stdout.write()
     *
     * Caveat: Synchronous call. For high-volume output, may
     * cause backpressure. Consider batching writes.
     *
     * @param data - Bytes to write
     */
    write(data: Uint8Array): void;

    /**
     * Write to stderr.
     *
     * Bun: process.stderr.write()
     *
     * @param data - Bytes to write
     */
    error(data: Uint8Array): void;

    /**
     * Check if stdout is a TTY.
     *
     * Bun: process.stdout.isTTY
     *
     * Useful for deciding whether to use colors/formatting.
     */
    isTTY(): boolean;
}

/**
 * Bun console device implementation
 *
 * Bun touchpoints:
 * - process.stdout.write(data)
 * - process.stderr.write(data)
 * - Bun.stdin for reading
 * - process.stdout.isTTY
 *
 * Caveats:
 * - Bun.stdin is a ReadableStream
 * - For line reading, we buffer until newline
 */
export class BunConsoleDevice implements ConsoleDevice {
    private stdinReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private stdinBuffer: Uint8Array = new Uint8Array(0);

    async read(): Promise<Uint8Array> {
        // Get or create reader
        if (!this.stdinReader) {
            this.stdinReader = Bun.stdin.stream().getReader();
        }

        const { value, done } = await this.stdinReader.read();
        if (done) {
            return new Uint8Array(0);
        }
        return value;
    }

    async readline(): Promise<string | null> {
        const decoder = new TextDecoder();

        while (true) {
            // Check buffer for newline
            const newlineIndex = this.stdinBuffer.indexOf(10); // '\n'
            if (newlineIndex !== -1) {
                const line = decoder.decode(this.stdinBuffer.slice(0, newlineIndex));
                this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
                // Remove trailing \r if present (Windows line endings)
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

    write(data: Uint8Array): void {
        process.stdout.write(data);
    }

    error(data: Uint8Array): void {
        process.stderr.write(data);
    }

    isTTY(): boolean {
        return process.stdout.isTTY ?? false;
    }
}

/**
 * Buffer console device for testing
 *
 * Captures all output and provides canned input.
 *
 * Usage:
 *   const console = new BufferConsoleDevice();
 *   console.setInput('hello\nworld\n');
 *   console.write(new TextEncoder().encode('output'));
 *   console.getOutput(); // 'output'
 */
export class BufferConsoleDevice implements ConsoleDevice {
    private input: Uint8Array = new Uint8Array(0);
    private inputPos = 0;
    private output: Uint8Array[] = [];
    private errors: Uint8Array[] = [];
    private tty = false;

    /**
     * Set input data that will be returned by read().
     */
    setInput(data: string | Uint8Array): void {
        this.input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        this.inputPos = 0;
    }

    /**
     * Get all captured stdout output as string.
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
     */
    reset(): void {
        this.input = new Uint8Array(0);
        this.inputPos = 0;
        this.output = [];
        this.errors = [];
    }

    /**
     * Set whether to report as TTY.
     */
    setTTY(isTTY: boolean): void {
        this.tty = isTTY;
    }

    async read(): Promise<Uint8Array> {
        if (this.inputPos >= this.input.length) {
            return new Uint8Array(0);
        }

        // Return remaining input
        const result = this.input.slice(this.inputPos);
        this.inputPos = this.input.length;
        return result;
    }

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

    write(data: Uint8Array): void {
        this.output.push(data.slice()); // Copy to prevent mutation
    }

    error(data: Uint8Array): void {
        this.errors.push(data.slice());
    }

    isTTY(): boolean {
        return this.tty;
    }
}
