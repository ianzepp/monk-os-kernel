/**
 * AI App Library - Re-exports for the AI process
 *
 * PURPOSE
 * =======
 * Central export point for all AI app library modules. Import from
 * './lib/index.js' to access types, configuration, and functions.
 *
 * @module rom/app/ai/lib
 */

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type {
    Instruction,
    TaskResult,
    ExecResult,
    CompletionResponse,
    BangCommandType,
    ParsedBangCommand,
    SpawnArgs,
    EmsArgs,
    CallArgs,
    SpawnedAgent,
    ExecuteTaskOptions,
    StmEntry,
    LtmEntry,
    ModelSchema,
} from './types.js';

// =============================================================================
// CONFIGURATION EXPORTS
// =============================================================================

export {
    DEFAULT_MODEL,
    MAX_EXEC_ITERATIONS,
    SYSTEM_PROMPT_PATH,
    HELP_PATH,
    DISCOVERY_PROMPT_PATH,
    WAKE_PROMPT_PATH,
    MEMORY_DIR,
    IDENTITY_PATH,
    SESSION_LOG_PATH,
    CONTEXT_PATH,
    ID_CHARS,
    REQUEST_ID_LENGTH,
    SPAWN_ID_LENGTH,
} from './config.js';

// =============================================================================
// LOGGING EXPORTS
// =============================================================================

export {
    log,
    debugInit,
    generateRequestId,
    generateSpawnId,
} from './logging.js';

// =============================================================================
// STATE EXPORTS
// =============================================================================

export {
    getSystemPrompt,
    setSystemPrompt,
    getDiscoveryPrompt,
    setDiscoveryPrompt,
    getWakePrompt,
    setWakePrompt,
    getIdentity,
    setIdentity,
    getMemoryContext,
    setMemoryContext,
    getEmsSchema,
    setEmsSchema,
    getAvailableCommands,
    setAvailableCommands,
    isTickBusy,
    setTickBusy,
    getSpawnedAgent,
    setSpawnedAgent,
    deleteSpawnedAgent,
    getAllSpawnedAgents,
    getSpawnedAgentCount,
    clearSpawnedAgents,
    markAgentDone,
} from './state.js';

// =============================================================================
// SESSION EXPORTS
// =============================================================================

export {
    logSession,
} from './session.js';

// =============================================================================
// EXEC EXPORTS
// =============================================================================

export {
    findCommand,
    exec,
    executeCall,
} from './exec.js';

// =============================================================================
// BANG COMMAND EXPORTS
// =============================================================================

export {
    parseBangCommands,
    parseCallArgs,
    executeBangCommand,
    getBangCommandDescription,
} from './bang.js';

export type { BangExecutionContext } from './bang.js';

// =============================================================================
// TASK EXPORTS
// =============================================================================

export {
    executeTask,
} from './task.js';

// =============================================================================
// MEMORY EXPORTS
// =============================================================================

export {
    consolidateMemory,
} from './memory.js';
