/**
 * ai - Main AI process for Monk OS
 *
 * SYNOPSIS
 * ========
 * ai
 *
 * DESCRIPTION
 * ===========
 * The AI process is the primary AI agent that starts when Monk OS boots.
 * It runs as a tick-driven daemon, receiving tasks via the system gateway
 * and coordinating AI work within the OS.
 *
 * The AI implements an agentic loop: it receives tasks, sends them to
 * an LLM, parses any "bang commands" (like !exec, !call, !spawn) from
 * the response, executes them, and feeds results back until the LLM
 * produces a final response.
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
 * 1 - Fatal error
 *
 * @module rom/app/ai/main
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
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
    executeTask,
    consolidateMemory,
} from './lib/index.js';

import type { ModelSchema } from './lib/index.js';

// =============================================================================
// MAIN
// =============================================================================

/**
 * Entry point for the AI process.
 *
 * Initializes state, subscribes to ticks, and waits for shutdown signal.
 * Tasks are received via the system gateway, not direct network connections.
 */
export default async function main(): Promise<void> {
    const pid = await getpid();

    await log(`ai: starting (pid ${pid})`);

    // -------------------------------------------------------------------------
    // Load System Prompt
    // -------------------------------------------------------------------------

    try {
        const systemPrompt = await readFile(SYSTEM_PROMPT_PATH);

        setSystemPrompt(systemPrompt);
        await log(`ai: loaded system prompt (${systemPrompt.length} chars)`);
    }
    catch {
        await log('ai: no system prompt found, running without');
    }

    // -------------------------------------------------------------------------
    // Initialize Memory Directory
    // -------------------------------------------------------------------------

    try {
        await mkdir(MEMORY_DIR, { recursive: true });
        await log(`ai: memory directory ready at ${MEMORY_DIR}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await log(`ai: failed to create memory directory: ${message}`);
    }

    // -------------------------------------------------------------------------
    // Load Existing Identity
    // -------------------------------------------------------------------------

    try {
        const identity = await readFile(IDENTITY_PATH);

        setIdentity(identity);
        await log(`ai: loaded existing identity (${identity.length} chars)`);
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
        await log(`ai: loaded memory context (${memoryContext.length} chars)`);
    }
    catch {
        // No context yet - will be created by distillation
    }

    // -------------------------------------------------------------------------
    // Subscribe to Kernel Ticks
    // -------------------------------------------------------------------------

    await subscribeTicks();
    await log('ai: subscribed to kernel ticks');

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

            await log(`ai: tick error: ${message}`);
        }
        finally {
            setTickBusy(false);
        }
    });

    // -------------------------------------------------------------------------
    // Wait for Shutdown
    // -------------------------------------------------------------------------

    let running = true;

    onSignal(() => {
        running = false;
        log('ai: received shutdown signal');
    });

    // Keep process alive while waiting for shutdown
    while (running) {
        await sleep(1000);
    }

    await log('ai: shutdown complete');
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
        await log(`ai: heartbeat tick=${seq}`);
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
    // Load EMS schema so AI understands available data models
    await log('ai: tick 1 - loading EMS schema');

    try {
        const models = await collect<ModelSchema>('ems:describe');
        const schemaLines = models.map(m => {
            const fields = m.fields.map(f => f.field_name).join(', ');

            return `${m.model_name}: ${fields}`;
        });

        setEmsSchema(schemaLines.join('\n'));
        await log(`ai: loaded ${models.length} EMS models`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await log(`ai: failed to load EMS schema: ${msg}`);
    }

    // Self-discovery (only if no identity exists)
    if (!getIdentity()) {
        await log('ai: tick 1 - performing self-discovery');

        const result = await executeTask(
            {
                task: 'You just woke up. Describe your environment and capabilities based on your system knowledge. Be concise (2-3 sentences).',
            },
            { skipLogging: true },
            consolidateMemory,
        );

        if (result.status === 'ok' && result.result) {
            setIdentity(result.result);
            await log(`ai: self-discovery complete`);
            await log(`ai: ${result.result}`);

            // Persist identity to file
            try {
                await writeFile(IDENTITY_PATH, result.result);
                await log(`ai: identity saved to ${IDENTITY_PATH}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                await log(`ai: failed to save identity: ${msg}`);
            }
        }
        else {
            await log(`ai: self-discovery failed: ${result.error}`);
        }
    }
}
