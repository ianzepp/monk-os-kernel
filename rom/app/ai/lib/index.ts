/**
 * Prior Library - Re-exports for the Prior AI process
 *
 * PURPOSE
 * =======
 * Central export point for all Prior library modules. Import from
 * '@rom/lib/prior' to access types, configuration, and functions.
 *
 * @module rom/lib/prior
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
    HttpRequest,
    ExecuteTaskOptions,
    StmEntry,
    LtmEntry,
    ModelSchema,
} from './types.js';

// =============================================================================
// CONFIGURATION EXPORTS
// =============================================================================

export {
    DEFAULT_PORT,
    DEFAULT_MODEL,
    MAX_EXEC_ITERATIONS,
    SYSTEM_PROMPT_PATH,
    HELP_PATH,
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
    generateRequestId,
    generateSpawnId,
} from './logging.js';

// =============================================================================
// STATE EXPORTS
// =============================================================================

export {
    getSystemPrompt,
    setSystemPrompt,
    getIdentity,
    setIdentity,
    getMemoryContext,
    setMemoryContext,
    getEmsSchema,
    setEmsSchema,
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
// SOCKET EXPORTS
// =============================================================================

export {
    readSocket,
    writeSocket,
} from './socket.js';

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

// =============================================================================
// HTTP EXPORTS
// =============================================================================

export {
    handleConnection,
} from './http.js';
