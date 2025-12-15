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
 * - Every 60 ticks (~60s): Wake cycle - check processes, reminders, health
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
    call,
    collect,
    onSignal,
    onTick,
    onSigcall,
    subscribeTicks,
    getpid,
    sleep,
    readFile,
    writeFile,
    mkdir,
    respond,
} from '@rom/lib/process/index.js';

import {
    SYSTEM_PROMPT_PATH,
    DISCOVERY_PROMPT_PATH,
    WAKE_PROMPT_PATH,
    MEMORY_DIR,
    IDENTITY_PATH,
    CONTEXT_PATH,
    log,
    setSystemPrompt,
    setDiscoveryPrompt,
    getDiscoveryPrompt,
    setWakePrompt,
    getWakePrompt,
    getIdentity,
    setIdentity,
    setMemoryContext,
    setEmsSchema,
    isTickBusy,
    setTickBusy,
    executeTask,
    consolidateMemory,
} from './lib/index.js';

import type { ModelSchema, Instruction, TaskResult } from './lib/index.js';

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
    // Load Prompt Templates
    // -------------------------------------------------------------------------

    try {
        const discoveryPrompt = await readFile(DISCOVERY_PROMPT_PATH);

        setDiscoveryPrompt(discoveryPrompt);
        await log(`ai: loaded discovery prompt template`);
    }
    catch {
        await log('ai: no discovery prompt template found');
    }

    try {
        const wakePrompt = await readFile(WAKE_PROMPT_PATH);

        setWakePrompt(wakePrompt);
        await log(`ai: loaded wake prompt template`);
    }
    catch {
        await log('ai: no wake prompt template found');
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
    // Register Sigcalls (ai:task, ai:chat)
    // -------------------------------------------------------------------------

    try {
        await call('sigcall:register', 'ai:task');
        await log('ai: registered sigcall ai:task');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`ai: failed to register ai:task: ${msg}`);
    }

    // Handler for ai:task - execute a task and return result
    onSigcall('ai:task', async function*(instruction: unknown) {
        const instr = instruction as Instruction;

        if (!instr || typeof instr.task !== 'string') {
            yield respond.error('EINVAL', 'instruction.task must be a string');
            return;
        }

        await log(`ai: received task: ${instr.task.slice(0, 50)}...`);

        try {
            const result: TaskResult = await executeTask(instr, {}, consolidateMemory);

            if (result.status === 'ok') {
                yield respond.ok({
                    result: result.result,
                    model: result.model,
                    duration_ms: result.duration_ms,
                    request_id: result.request_id,
                });
            }
            else {
                yield respond.error('EIO', result.error ?? 'Task failed');
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await log(`ai: task error: ${msg}`);
            yield respond.error('EIO', msg);
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

    // Wake cycle (every 60 ticks = ~60 seconds)
    if (seq % 60 === 0 && seq > 1) {
        await handleWakeCycle(seq);
    }

    // Memory consolidation (every 600 ticks = ~10 minutes)
    if (seq % 600 === 0) {
        await consolidateMemory();
    }
}

/**
 * Handle the first tick - load EMS schema, scan /bin, and self-discovery.
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

        const discoveryPrompt = getDiscoveryPrompt()
            ?? 'You just woke up. Describe your environment and capabilities. Be concise.';

        const result = await executeTask(
            { task: discoveryPrompt },
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

// =============================================================================
// WAKE CYCLE
// =============================================================================

/**
 * Process info from proc:list
 */
interface ProcessInfo {
    pid: number;
    ppid: number;
    cmd: string;
    state: string;
    startedAt: string;
}

/**
 * STM record with reminder
 */
interface StmRecord {
    id: string;
    content: string;
    salience: number;
    reminder_at: string | null;
    consolidated: boolean;
}

/**
 * Handle the wake cycle - periodic housekeeping and awareness.
 *
 * Gathers system state (processes, reminders, recent activity) and
 * prompts Prior to review and take any needed actions.
 */
async function handleWakeCycle(seq: number): Promise<void> {
    await log(`ai: wake cycle tick=${seq}`);

    // Gather system state
    const state = await gatherSystemState();

    // Build wake prompt
    const prompt = buildWakePrompt(state);

    // Execute with haiku for speed/cost
    const result = await executeTask(
        { task: prompt, model: 'claude-haiku-3.5' },
        { skipLogging: true },
        consolidateMemory,
    );

    if (result.status === 'ok' && result.result) {
        // Log what Prior said
        const response = String(result.result).trim();
        const preview = response.length > 200
            ? response.slice(0, 200) + '...'
            : response;

        await log(`ai: wake - ${preview}`);
    }
    else {
        await log(`ai: wake cycle error: ${result.error}`);
    }
}

/**
 * System state gathered for wake cycle
 */
interface SystemState {
    processes: ProcessInfo[];
    processCount: number;
    reminders: StmRecord[];
    hasReminders: boolean;
    recentStm: StmRecord[];
    timestamp: string;
}

/**
 * Gather current system state for wake cycle review.
 */
async function gatherSystemState(): Promise<SystemState> {
    const timestamp = new Date().toISOString();
    let processes: ProcessInfo[] = [];
    let reminders: StmRecord[] = [];
    let recentStm: StmRecord[] = [];

    // Get running processes
    try {
        processes = await collect<ProcessInfo>('proc:list');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await log(`ai: wake - failed to list processes: ${msg}`);
    }

    // Get due reminders (reminder_at <= now and not consolidated)
    try {
        reminders = await collect<StmRecord>(
            'ems:select',
            'ai.stm',
            {
                where: {
                    reminder_at: { $lte: timestamp },
                    consolidated: false,
                },
                limit: 10,
            },
        );
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await log(`ai: wake - failed to query reminders: ${msg}`);
    }

    // Get recent unconsolidated STM (last 5, high salience)
    try {
        recentStm = await collect<StmRecord>(
            'ems:select',
            'ai.stm',
            {
                where: { consolidated: false, reminder_at: { $null: true } },
                order: [
                    { field: 'salience', sort: 'desc' },
                    { field: 'created_at', sort: 'desc' },
                ],
                limit: 5,
            },
        );
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await log(`ai: wake - failed to query recent stm: ${msg}`);
    }

    return {
        processes,
        processCount: processes.length,
        reminders,
        hasReminders: reminders.length > 0,
        recentStm,
        timestamp,
    };
}

/**
 * Build the wake cycle prompt from system state.
 * Uses template from /app/ai/etc/wake.txt with placeholder substitution.
 */
function buildWakePrompt(state: SystemState): string {
    const template = getWakePrompt();

    // Build process list
    let processes: string;

    if (state.processes.length === 0) {
        processes = 'None (unexpected - at least init should be running)';
    }
    else {
        processes = state.processes
            .map(p => `- PID ${p.pid}: ${p.cmd} (${p.state})`)
            .join('\n');
    }

    // Build reminders list
    let reminders: string;

    if (state.reminders.length === 0) {
        reminders = 'None';
    }
    else {
        const items = state.reminders
            .map(r => `- [${r.id}] (salience ${r.salience}): ${r.content}`)
            .join('\n');

        reminders = `${items}\n\nAfter handling a reminder, mark it consolidated:\n!ems update ai.stm <id> consolidated=true`;
    }

    // Build observations list
    let observations: string;

    if (state.recentStm.length === 0) {
        observations = 'None';
    }
    else {
        observations = state.recentStm
            .map(s => `- (salience ${s.salience}): ${s.content.slice(0, 100)}...`)
            .join('\n');
    }

    // If template exists, use placeholder substitution
    if (template) {
        return template
            .replace(/\{\{timestamp\}\}/g, state.timestamp)
            .replace(/\{\{processCount\}\}/g, String(state.processCount))
            .replace(/\{\{processes\}\}/g, processes)
            .replace(/\{\{reminderCount\}\}/g, String(state.reminders.length))
            .replace(/\{\{reminders\}\}/g, reminders)
            .replace(/\{\{observationCount\}\}/g, String(state.recentStm.length))
            .replace(/\{\{observations\}\}/g, observations);
    }

    // Fallback if no template
    return [
        'Wake cycle check. Review system state and take any needed actions.',
        '',
        `Time: ${state.timestamp}`,
        '',
        `## Running Processes (${state.processCount})`,
        processes,
        '',
        `## Due Reminders (${state.reminders.length})`,
        reminders,
        '',
        `## Recent Observations (${state.recentStm.length})`,
        observations,
        '',
        '## Instructions',
        '- If reminders need action, handle them with !exec or !call',
        '- If processes look abnormal, investigate',
        '- If nothing needs attention, respond briefly: "All quiet."',
        '- To set a new reminder: !ems create ai.stm content="..." salience=N reminder_at="ISO8601"',
    ].join('\n');
}
