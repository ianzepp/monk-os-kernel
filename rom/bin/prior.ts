/**
 * prior - Main AI process for Monk OS
 *
 * SYNOPSIS
 * ========
 * prior
 *
 * DESCRIPTION
 * ===========
 * The Prior is the primary AI process that starts when Monk OS boots.
 * It listens on a TCP port for external instructions (from Abbot CLI,
 * Claude Code, or other clients) and coordinates AI work within the OS.
 *
 * Prior implements an agentic loop: it receives tasks, sends them to
 * an LLM, parses any "bang commands" (like !exec, !call, !spawn) from
 * the response, executes them, and feeds results back until the LLM
 * produces a final response.
 *
 * PROTOCOL
 * ========
 * HTTP over TCP on port 7777 (default).
 * - POST / with JSON body: { task: string, context?: object, model?: string }
 * - Response: { status, result?, error?, model?, duration_ms?, request_id? }
 *
 * TICK BEHAVIOR
 * =============
 * - Tick 1: Load EMS schema, perform self-discovery if no identity
 * - Every 60 ticks (~60s): Heartbeat log
 * - Every 600 ticks (~10min): Memory consolidation
 *
 * EXIT CODES
 * ==========
 * 0 - Normal shutdown
 * 1 - Fatal error (port binding failed, etc.)
 *
 * @module rom/bin/prior
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    call,
    collect,
    onSignal,
    onTick,
    subscribeTicks,
    getpid,
    sleep,
    readFile,
    writeFile,
    mkdir,
} from '@rom/lib/process/index.js';

import {
    DEFAULT_PORT,
    SYSTEM_PROMPT_PATH,
    MEMORY_DIR,
    IDENTITY_PATH,
    CONTEXT_PATH,
    log,
    setSystemPrompt,
    getIdentity,
    setIdentity,
    setMemoryContext,
    setEmsSchema,
    isTickBusy,
    setTickBusy,
    handleConnection,
    executeTask,
    consolidateMemory,
} from '@rom/lib/prior/index.js';

import type { ModelSchema } from '@rom/lib/prior/index.js';

// =============================================================================
// MAIN
// =============================================================================

/**
 * Entry point for Prior.
 *
 * Initializes state, subscribes to ticks, binds TCP port, and enters
 * the connection accept loop.
 */
export default async function main(): Promise<void> {
    const pid = await getpid();

    await log(`prior: starting (pid ${pid})`);

    // -------------------------------------------------------------------------
    // Load System Prompt
    // -------------------------------------------------------------------------

    try {
        const systemPrompt = await readFile(SYSTEM_PROMPT_PATH);
        setSystemPrompt(systemPrompt);
        await log(`prior: loaded system prompt (${systemPrompt.length} chars)`);
    }
    catch {
        await log('prior: no system prompt found, running without');
    }

    // -------------------------------------------------------------------------
    // Initialize Memory Directory
    // -------------------------------------------------------------------------

    try {
        await mkdir(MEMORY_DIR, { recursive: true });
        await log(`prior: memory directory ready at ${MEMORY_DIR}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await log(`prior: failed to create memory directory: ${message}`);
    }

    // -------------------------------------------------------------------------
    // Load Existing Identity
    // -------------------------------------------------------------------------

    try {
        const identity = await readFile(IDENTITY_PATH);
        setIdentity(identity);
        await log(`prior: loaded existing identity (${identity.length} chars)`);
    }
    catch {
        // No identity yet - will be created on first tick
    }

    // -------------------------------------------------------------------------
    // Load Existing Memory Context
    // -------------------------------------------------------------------------

    try {
        const memoryContext = await readFile(CONTEXT_PATH);
        setMemoryContext(memoryContext);
        await log(`prior: loaded memory context (${memoryContext.length} chars)`);
    }
    catch {
        // No context yet - will be created by distillation
    }

    // -------------------------------------------------------------------------
    // Subscribe to Kernel Ticks
    // -------------------------------------------------------------------------

    await subscribeTicks();
    await log('prior: subscribed to kernel ticks');

    // Register tick handler
    onTick(async (_dt, _now, seq) => {
        // Skip if already processing a tick (prevent overlap)
        if (isTickBusy()) {
            return;
        }

        setTickBusy(true);

        try {
            await handleTick(seq);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await log(`prior: tick error: ${message}`);
        }
        finally {
            setTickBusy(false);
        }
    });

    // -------------------------------------------------------------------------
    // Handle Shutdown
    // -------------------------------------------------------------------------

    let running = true;

    onSignal(() => {
        running = false;
        log('prior: received shutdown signal');
    });

    // -------------------------------------------------------------------------
    // Create TCP Listener
    // -------------------------------------------------------------------------

    const port = DEFAULT_PORT;
    let listenerFd: number;

    try {
        listenerFd = await call<number>('port:create', 'tcp:listen', { port });
        await log(`prior: listening on tcp://0.0.0.0:${port}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await log(`prior: failed to bind port ${port}: ${message}`);
        return;
    }

    // -------------------------------------------------------------------------
    // Accept Connections
    // -------------------------------------------------------------------------

    while (running) {
        try {
            // Accept next connection
            const msg = await call<{ from: string; fd: number }>('port:recv', listenerFd);

            if (!msg.fd) {
                await log('prior: received connection without socket fd');
                continue;
            }

            await log(`prior: connection from ${msg.from}`);

            // Handle connection (channel:accept consumes socket fd, handleConnection closes channel)
            await handleConnection(msg.fd, msg.from);
        }
        catch (err) {
            if (!running) {
                break;
            }

            const message = err instanceof Error ? err.message : String(err);
            await log(`prior: accept error: ${message}`);
            await sleep(1000); // Back off on errors
        }
    }

    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------

    try {
        await call<void>('port:close', listenerFd);
    }
    catch {
        // Ignore close errors during shutdown
    }

    await log('prior: shutdown complete');
}

// =============================================================================
// TICK HANDLING
// =============================================================================

/**
 * Handle a kernel tick.
 *
 * @param seq - Tick sequence number
 */
async function handleTick(seq: number): Promise<void> {
    // First tick: load EMS schema and perform self-discovery
    if (seq === 1) {
        await handleFirstTick();
    }

    // Periodic heartbeat (every 60 ticks = ~60 seconds)
    if (seq % 60 === 0) {
        await log(`prior: heartbeat tick=${seq}`);
    }

    // Memory consolidation (every 600 ticks = ~10 minutes)
    if (seq % 600 === 0) {
        await consolidateMemory();
    }
}

/**
 * Handle the first tick - load EMS schema and self-discovery.
 */
async function handleFirstTick(): Promise<void> {
    // Load EMS schema so Prior understands available data models
    await log('prior: tick 1 - loading EMS schema');

    try {
        const models = await collect<ModelSchema>('ems:describe');
        const schemaLines = models.map(m => {
            const fields = m.fields.map(f => f.field_name).join(', ');
            return `${m.model_name}: ${fields}`;
        });
        setEmsSchema(schemaLines.join('\n'));
        await log(`prior: loaded ${models.length} EMS models`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`prior: failed to load EMS schema: ${msg}`);
    }

    // Self-discovery (only if no identity exists)
    if (!getIdentity()) {
        await log('prior: tick 1 - performing self-discovery');

        const result = await executeTask(
            {
                task: 'You just woke up. Describe your environment and capabilities based on your system knowledge. Be concise (2-3 sentences).',
            },
            { skipLogging: true },
            consolidateMemory
        );

        if (result.status === 'ok' && result.result) {
            setIdentity(result.result);
            await log(`prior: self-discovery complete`);
            await log(`prior: ${result.result}`);

            // Persist identity to file
            try {
                await writeFile(IDENTITY_PATH, result.result);
                await log(`prior: identity saved to ${IDENTITY_PATH}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await log(`prior: failed to save identity: ${msg}`);
            }
        }
        else {
            await log(`prior: self-discovery failed: ${result.error}`);
        }
    }
}
