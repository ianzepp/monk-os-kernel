/**
 * AI App Types - Type definitions for the AI process
 *
 * PURPOSE
 * =======
 * Centralizes all type definitions used by the AI process and its
 * supporting libraries. This includes instruction formats, task results,
 * LLM responses, and internal state structures.
 *
 * API DESIGN
 * ==========
 * All types are exported for use by both the AI app and any external
 * code that needs to interact with it (e.g., test harnesses, clients).
 *
 * @module rom/app/ai/lib/types
 */

// =============================================================================
// INSTRUCTION TYPES
// =============================================================================

/**
 * An instruction sent to Prior for execution.
 *
 * This is the primary input format for tasks. Clients send these
 * over the TCP/HTTP interface.
 */
export interface Instruction {
    /** The task description or prompt */
    task: string;
    /** Optional context data passed to the LLM */
    context?: Record<string, unknown>;
    /** Optional model override (defaults to claude-sonnet-4) */
    model?: string;
}

// =============================================================================
// RESULT TYPES
// =============================================================================

/**
 * Result of executing a task.
 *
 * Returned to clients after task completion.
 */
export interface TaskResult {
    /** Whether the task succeeded or failed */
    status: 'ok' | 'error';
    /** The final result text (on success) */
    result?: string;
    /** Error message (on failure) */
    error?: string;
    /** Model used for completion */
    model?: string;
    /** Execution time in milliseconds */
    duration_ms?: number;
    /** Request ID for correlation */
    request_id?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
    /** Standard output */
    stdout: string;
    /** Standard error */
    stderr: string;
    /** Exit code */
    code: number;
}

// =============================================================================
// LLM TYPES
// =============================================================================

/**
 * Response from the llm:complete syscall.
 */
export interface CompletionResponse {
    /** The generated text */
    text: string;
    /** The model that generated the response */
    model: string;
    /** Token usage statistics */
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

// =============================================================================
// BANG COMMAND TYPES
// =============================================================================

/**
 * Supported bang command types.
 */
export type BangCommandType =
    | 'exec'
    | 'call'
    | 'stm'
    | 'ltm'
    | 'help'
    | 'spawn'
    | 'wait'
    | 'ref'
    | 'coalesce'
    | 'ems';

/**
 * A parsed bang command from LLM output.
 */
export interface ParsedBangCommand {
    type: BangCommandType;
    args: unknown;
}

/**
 * Arguments for the !spawn command.
 */
export interface SpawnArgs {
    task: string;
    model?: string;
}

/**
 * Arguments for the !ems command.
 */
export interface EmsArgs {
    subcommand: string;
    args: string;
}

/**
 * Arguments for the !call command.
 */
export interface CallArgs {
    name: string;
    args: unknown[];
}

// =============================================================================
// SPAWNED AGENT TYPES
// =============================================================================

/**
 * Tracks a spawned subagent.
 */
export interface SpawnedAgent {
    /** Unique spawn identifier (spawn:xxxxxxxx) */
    id: string;
    /** The task the agent is working on */
    task: string;
    /** The model being used */
    model: string;
    /** Promise that resolves when the agent completes */
    promise: Promise<TaskResult>;
    /** The result once complete */
    result?: TaskResult;
    /** Whether the agent has finished */
    done: boolean;
}

// =============================================================================
// EXECUTION OPTIONS
// =============================================================================

/**
 * Options for task execution.
 */
export interface ExecuteTaskOptions {
    /** Skip logging to session log and STM */
    skipLogging?: boolean;
    /** Client address for tracking */
    clientAddr?: string;
}

// =============================================================================
// EMS TYPES (for memory operations)
// =============================================================================

/**
 * Short-term memory entry.
 */
export interface StmEntry {
    id: string;
    content: string;
    context: string;
    salience: number;
    /** Whether this entry has been consolidated into LTM (0 or 1 in SQLite) */
    consolidated?: number;
    consolidated_at?: string;
}

/**
 * Long-term memory entry.
 */
export interface LtmEntry {
    id: string;
    content: string;
    category: string;
    reinforced: number;
    created_at?: string;
}

/**
 * EMS model schema information.
 */
export interface ModelSchema {
    model_name: string;
    status: string;
    description: string | null;
    fields: Array<{ field_name: string; type: string }>;
}
