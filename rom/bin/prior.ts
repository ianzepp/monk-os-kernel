/**
 * Prior - Main AI Process
 *
 * The Prior is the primary AI process that starts when Monk OS boots.
 * It listens on a TCP port for external instructions (from Abbot CLI,
 * Claude Code, or other clients) and coordinates AI work within the OS.
 *
 * Protocol: JSON lines over TCP
 * - Client sends: {"task": "...", "context": {...}}\n
 * - Prior responds: {"status": "ok"|"error", "result": "...", ...}\n
 *
 * @module rom/bin/prior
 */

import {
    call,
    syscall,
    onSignal,
    println,
    eprintln,
    getpid,
    sleep,
} from '@rom/lib/process/index.js';
import type { Response } from '@rom/lib/process/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_PORT = 7777;
const DEFAULT_MODEL = 'qwen2.5-coder:1.5b';

// =============================================================================
// TYPES
// =============================================================================

interface Instruction {
    task: string;
    context?: Record<string, unknown>;
    model?: string;
}

interface TaskResult {
    status: 'ok' | 'error';
    result?: string;
    error?: string;
    model?: string;
    duration_ms?: number;
}

interface CompletionResponse {
    text: string;
    model: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

// =============================================================================
// SOCKET I/O HELPERS
// =============================================================================

/**
 * Read all data from a socket until connection closes or newline received.
 * Returns the data as a string.
 */
async function readSocket(socketFd: number): Promise<string> {
    const chunks: Uint8Array[] = [];

    for await (const response of syscall('handle:send', socketFd, { op: 'recv' })) {
        if (response.op === 'data' && response.bytes) {
            chunks.push(response.bytes);

            // Check for newline (JSON lines protocol)
            const lastChunk = response.bytes;
            if (lastChunk.includes(10)) { // \n
                break;
            }
        }
        else if (response.op === 'done' || response.op === 'ok') {
            break;
        }
        else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new Error(`Socket read error: ${err.code} - ${err.message}`);
        }
    }

    // Concatenate chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return new TextDecoder().decode(result).trim();
}

/**
 * Write data to a socket.
 */
async function writeSocket(socketFd: number, data: string): Promise<void> {
    const bytes = new TextEncoder().encode(data);

    for await (const response of syscall('handle:send', socketFd, { op: 'send', data: { data: bytes } })) {
        if (response.op === 'ok') {
            return;
        }
        else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new Error(`Socket write error: ${err.code} - ${err.message}`);
        }
    }
}

// =============================================================================
// TASK EXECUTION
// =============================================================================

/**
 * Execute a task using the LLM.
 */
async function executeTask(instruction: Instruction): Promise<TaskResult> {
    const startTime = Date.now();
    const model = instruction.model ?? DEFAULT_MODEL;

    try {
        // Build prompt from task and context
        let prompt = instruction.task;

        if (instruction.context) {
            prompt = `Context:\n${JSON.stringify(instruction.context, null, 2)}\n\nTask: ${instruction.task}`;
        }

        // Call LLM
        const response = await call<CompletionResponse>('llm:complete', model, prompt);

        return {
            status: 'ok',
            result: response.text,
            model: response.model,
            duration_ms: Date.now() - startTime,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        return {
            status: 'error',
            error: message,
            duration_ms: Date.now() - startTime,
        };
    }
}

// =============================================================================
// CONNECTION HANDLER
// =============================================================================

/**
 * Handle a single client connection.
 */
async function handleConnection(socketFd: number, from: string): Promise<void> {
    try {
        // Read instruction
        const rawData = await readSocket(socketFd);

        if (!rawData) {
            await writeSocket(socketFd, JSON.stringify({ status: 'error', error: 'Empty request' }) + '\n');
            return;
        }

        // Parse JSON
        let instruction: Instruction;

        try {
            instruction = JSON.parse(rawData) as Instruction;
        }
        catch {
            await writeSocket(socketFd, JSON.stringify({ status: 'error', error: 'Invalid JSON' }) + '\n');
            return;
        }

        // Validate
        if (!instruction.task || typeof instruction.task !== 'string') {
            await writeSocket(socketFd, JSON.stringify({ status: 'error', error: 'Missing or invalid task field' }) + '\n');
            return;
        }

        await eprintln(`prior: received task from ${from}: ${instruction.task.slice(0, 50)}...`);

        // Execute task
        const result = await executeTask(instruction);

        // Send response
        await writeSocket(socketFd, JSON.stringify(result) + '\n');

        await eprintln(`prior: completed task in ${result.duration_ms}ms`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`prior: connection error: ${message}`);

        try {
            await writeSocket(socketFd, JSON.stringify({ status: 'error', error: message }) + '\n');
        }
        catch {
            // Ignore write errors during error handling
        }
    }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    const pid = await getpid();

    await println(`prior: starting (pid ${pid})`);

    // Handle shutdown gracefully
    let running = true;

    onSignal(() => {
        running = false;
        eprintln('prior: received shutdown signal');
    });

    // Create TCP listener
    const port = DEFAULT_PORT;
    let listenerFd: number;

    try {
        listenerFd = await call<number>('port:create', 'tcp:listen', { port });
        await println(`prior: listening on tcp://0.0.0.0:${port}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`prior: failed to bind port ${port}: ${message}`);
        return;
    }

    // Accept connections
    while (running) {
        try {
            // Accept next connection
            const msg = await call<{ from: string; fd: number }>('port:recv', listenerFd);

            if (!msg.fd) {
                await eprintln('prior: received connection without socket fd');
                continue;
            }

            await eprintln(`prior: connection from ${msg.from}`);

            // Handle connection (sequentially for now)
            await handleConnection(msg.fd, msg.from);

            // Close socket
            await call<void>('handle:close', msg.fd);
        }
        catch (err) {
            if (!running) {
                break;
            }

            const message = err instanceof Error ? err.message : String(err);

            await eprintln(`prior: accept error: ${message}`);
            await sleep(1000); // Back off on errors
        }
    }

    // Cleanup
    try {
        await call<void>('port:close', listenerFd);
    }
    catch {
        // Ignore close errors during shutdown
    }

    await println('prior: shutdown complete');
}

// Run
main().catch(async (err) => {
    await eprintln(`prior: fatal error: ${err}`);
});
