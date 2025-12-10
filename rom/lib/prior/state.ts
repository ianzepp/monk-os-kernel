/**
 * Prior State - Global state management for the Prior AI process
 *
 * PURPOSE
 * =======
 * Manages the global state for Prior including loaded prompts, identity,
 * memory context, and spawned subagent tracking.
 *
 * DESIGN RATIONALE
 * ================
 * State is encapsulated in a singleton object with getter/setter functions.
 * This allows state to be shared across library modules while keeping
 * the interface explicit.
 *
 * WHY NOT CLASS: Prior is a single-instance process. A singleton object
 * is simpler than a class instance passed everywhere.
 *
 * @module rom/lib/prior/state
 */

// =============================================================================
// IMPORTS
// =============================================================================

import type { SpawnedAgent, TaskResult } from './types.js';

// =============================================================================
// STATE STORAGE
// =============================================================================

/**
 * Internal state container.
 */
const state = {
    /** System prompt loaded from /etc/prior/system.txt */
    systemPrompt: undefined as string | undefined,

    /** Prior's self-discovered identity */
    identity: undefined as string | undefined,

    /** Memory context for task execution */
    memoryContext: undefined as string | undefined,

    /** EMS schema summary */
    emsSchema: undefined as string | undefined,

    /** Whether a tick handler is currently processing */
    tickBusy: false,
};

/**
 * Map of spawned subagents by ID.
 */
const spawnedAgents = new Map<string, SpawnedAgent>();

// =============================================================================
// SYSTEM PROMPT
// =============================================================================

/**
 * Get the system prompt.
 */
export function getSystemPrompt(): string | undefined {
    return state.systemPrompt;
}

/**
 * Set the system prompt.
 */
export function setSystemPrompt(prompt: string | undefined): void {
    state.systemPrompt = prompt;
}

// =============================================================================
// IDENTITY
// =============================================================================

/**
 * Get Prior's identity.
 */
export function getIdentity(): string | undefined {
    return state.identity;
}

/**
 * Set Prior's identity.
 */
export function setIdentity(identity: string | undefined): void {
    state.identity = identity;
}

// =============================================================================
// MEMORY CONTEXT
// =============================================================================

/**
 * Get the memory context.
 */
export function getMemoryContext(): string | undefined {
    return state.memoryContext;
}

/**
 * Set the memory context.
 */
export function setMemoryContext(context: string | undefined): void {
    state.memoryContext = context;
}

// =============================================================================
// EMS SCHEMA
// =============================================================================

/**
 * Get the EMS schema.
 */
export function getEmsSchema(): string | undefined {
    return state.emsSchema;
}

/**
 * Set the EMS schema.
 */
export function setEmsSchema(schema: string | undefined): void {
    state.emsSchema = schema;
}

// =============================================================================
// TICK BUSY FLAG
// =============================================================================

/**
 * Check if tick handler is busy.
 */
export function isTickBusy(): boolean {
    return state.tickBusy;
}

/**
 * Set tick busy flag.
 */
export function setTickBusy(busy: boolean): void {
    state.tickBusy = busy;
}

// =============================================================================
// SPAWNED AGENTS
// =============================================================================

/**
 * Get a spawned agent by ID.
 */
export function getSpawnedAgent(id: string): SpawnedAgent | undefined {
    return spawnedAgents.get(id);
}

/**
 * Register a new spawned agent.
 */
export function setSpawnedAgent(id: string, agent: SpawnedAgent): void {
    spawnedAgents.set(id, agent);
}

/**
 * Remove a spawned agent.
 */
export function deleteSpawnedAgent(id: string): void {
    spawnedAgents.delete(id);
}

/**
 * Get all spawned agents.
 */
export function getAllSpawnedAgents(): Map<string, SpawnedAgent> {
    return spawnedAgents;
}

/**
 * Get the count of spawned agents.
 */
export function getSpawnedAgentCount(): number {
    return spawnedAgents.size;
}

/**
 * Clear all spawned agents.
 */
export function clearSpawnedAgents(): void {
    spawnedAgents.clear();
}

/**
 * Mark a spawned agent as done with its result.
 */
export function markAgentDone(id: string, result: TaskResult): void {
    const agent = spawnedAgents.get(id);

    if (agent) {
        agent.result = result;
        agent.done = true;
    }
}
