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
    onTick,
    subscribeTicks,
    println,
    eprintln,
    getpid,
    sleep,
    readFile,
    writeFile,
    appendFile,
    mkdir,
    stat,
} from '@rom/lib/process/index.js';
import type { Response } from '@rom/lib/process/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_PORT = 7777;
const DEFAULT_MODEL = 'claude-sonnet-4';
const SYSTEM_PROMPT_PATH = '/etc/prior/system.txt';

// Memory paths
const MEMORY_DIR = '/var/prior';
const IDENTITY_PATH = '/var/prior/identity.txt';
const SESSION_LOG_PATH = '/var/prior/session.log';
const CONTEXT_PATH = '/var/prior/context.txt';

// =============================================================================
// STATE
// =============================================================================

let systemPrompt: string | undefined;
let identity: string | undefined;
let memoryContext: string | undefined;
let tickBusy = false;

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
// SESSION LOGGING
// =============================================================================

/**
 * Log a task exchange to the session log.
 */
async function logSession(task: string, result: string, status: 'ok' | 'error'): Promise<void> {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] TASK: ${task.slice(0, 200)}${task.length > 200 ? '...' : ''}\n[${timestamp}] ${status.toUpperCase()}: ${result.slice(0, 500)}${result.length > 500 ? '...' : ''}\n\n`;

    try {
        await appendFile(SESSION_LOG_PATH, entry);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await eprintln(`prior: failed to log session: ${message}`);
    }
}

// =============================================================================
// TASK EXECUTION
// =============================================================================

/**
 * Execute a task using the LLM.
 */
async function executeTask(instruction: Instruction, skipLogging = false): Promise<TaskResult> {
    const startTime = Date.now();
    const model = instruction.model ?? DEFAULT_MODEL;

    try {
        // Build prompt with memory context
        const parts: string[] = [];

        // Include identity if available
        if (identity) {
            parts.push(`My identity: ${identity}`);
        }

        // Include memory context if available
        if (memoryContext) {
            parts.push(`Memory context:\n${memoryContext}`);
        }

        // Include instruction context if provided
        if (instruction.context) {
            parts.push(`Task context:\n${JSON.stringify(instruction.context, null, 2)}`);
        }

        // Add the actual task
        parts.push(`Task: ${instruction.task}`);

        const prompt = parts.join('\n\n');

        await eprintln(`prior: calling llm:complete with model=${model}`);

        // Call LLM with system prompt if available
        const response = await call<CompletionResponse>('llm:complete', model, prompt, {
            system: systemPrompt,
        });

        await eprintln(`prior: llm responded, ${response.text.length} chars`);

        const result: TaskResult = {
            status: 'ok',
            result: response.text,
            model: response.model,
            duration_ms: Date.now() - startTime,
        };

        // Log to session (skip for self-discovery to avoid circular logging)
        if (!skipLogging) {
            await logSession(instruction.task, response.text, 'ok');
        }

        return result;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`prior: llm error: ${message}`);

        const result: TaskResult = {
            status: 'error',
            error: message,
            duration_ms: Date.now() - startTime,
        };

        // Log errors too
        if (!skipLogging) {
            await logSession(instruction.task, message, 'error');
        }

        return result;
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
        await eprintln(`prior: executing task...`);
        const result = await executeTask(instruction);
        await eprintln(`prior: task complete, sending response...`);

        // Send response
        const responseJson = JSON.stringify(result) + '\n';
        await eprintln(`prior: writing ${responseJson.length} bytes to socket`);
        await writeSocket(socketFd, responseJson);

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

    // Load system prompt
    try {
        systemPrompt = await readFile(SYSTEM_PROMPT_PATH);
        await eprintln(`prior: loaded system prompt (${systemPrompt.length} chars)`);
    }
    catch {
        await eprintln('prior: no system prompt found, running without');
    }

    // Initialize memory directory
    try {
        await mkdir(MEMORY_DIR, { recursive: true });
        await eprintln(`prior: memory directory ready at ${MEMORY_DIR}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await eprintln(`prior: failed to create memory directory: ${message}`);
    }

    // Load existing identity if available
    try {
        identity = await readFile(IDENTITY_PATH);
        await eprintln(`prior: loaded existing identity (${identity.length} chars)`);
    }
    catch {
        // No identity yet - will be created on first tick
    }

    // Load existing context if available
    try {
        memoryContext = await readFile(CONTEXT_PATH);
        await eprintln(`prior: loaded memory context (${memoryContext.length} chars)`);
    }
    catch {
        // No context yet - will be created by distillation
    }

    // Subscribe to kernel ticks for autonomous behavior
    await subscribeTicks();
    await eprintln('prior: subscribed to kernel ticks');

    // Register tick handler
    onTick(async (dt, now, seq) => {
        // Skip if already processing a tick (prevent overlap)
        if (tickBusy) {
            return;
        }

        tickBusy = true;

        try {
            // First tick: self-discovery (only if no identity exists)
            if (seq === 1 && !identity) {
                await eprintln('prior: tick 1 - performing self-discovery');

                const result = await executeTask({
                    task: 'You just woke up. Describe your environment and capabilities based on your system knowledge. Be concise (2-3 sentences).',
                }, true);  // skipLogging - self-discovery is internal

                if (result.status === 'ok' && result.result) {
                    identity = result.result;
                    await eprintln(`prior: self-discovery complete`);
                    await eprintln(`prior: ${identity}`);

                    // Persist identity to file
                    try {
                        await writeFile(IDENTITY_PATH, identity);
                        await eprintln(`prior: identity saved to ${IDENTITY_PATH}`);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        await eprintln(`prior: failed to save identity: ${msg}`);
                    }
                }
                else {
                    await eprintln(`prior: self-discovery failed: ${result.error}`);
                }
            }

            // Periodic heartbeat (every 60 ticks = ~60 seconds)
            if (seq % 60 === 0) {
                await eprintln(`prior: heartbeat tick=${seq} dt=${dt}ms`);
            }

            // Future: check for autonomous work queue, consolidate memory, etc.
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await eprintln(`prior: tick error: ${message}`);
        }
        finally {
            tickBusy = false;
        }
    });

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
