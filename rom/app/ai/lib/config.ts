/**
 * AI App Configuration - Constants and defaults for the AI process
 *
 * PURPOSE
 * =======
 * Centralizes all configuration constants used by the AI process. This
 * includes AI settings, file paths, and operational limits.
 *
 * DESIGN RATIONALE
 * ================
 * Constants are grouped by concern:
 * - AI: Model defaults, iteration limits
 * - Paths: VFS locations for prompts, memory, logs
 *
 * @module rom/app/ai/lib/config
 */

// =============================================================================
// AI CONFIGURATION
// =============================================================================

/**
 * Default LLM model for task execution.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4';

/**
 * Maximum iterations for the agentic loop.
 * WHY: Prevents runaway loops if the LLM keeps emitting commands.
 */
export const MAX_EXEC_ITERATIONS = 10;

// =============================================================================
// FILE PATHS
// =============================================================================

/**
 * Path to the system prompt file.
 */
export const SYSTEM_PROMPT_PATH = '/app/ai/etc/system.txt';

/**
 * Path to the help text file.
 */
export const HELP_PATH = '/app/ai/etc/help.txt';

/**
 * Path to the self-discovery prompt template.
 */
export const DISCOVERY_PROMPT_PATH = '/app/ai/etc/discovery.txt';

/**
 * Path to the wake cycle prompt template.
 */
export const WAKE_PROMPT_PATH = '/app/ai/etc/wake.txt';

/**
 * Directory for Prior's persistent memory.
 */
export const MEMORY_DIR = '/var/ai';

/**
 * Path to the identity file (Prior's self-description).
 */
export const IDENTITY_PATH = '/var/ai/identity.txt';

/**
 * Path to the session log file.
 */
export const SESSION_LOG_PATH = '/var/ai/session.log';

/**
 * Path to the memory context file.
 */
export const CONTEXT_PATH = '/var/ai/context.txt';

// =============================================================================
// RANDOM ID CONFIGURATION
// =============================================================================

/**
 * Characters used for generating random IDs.
 */
export const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Length of request IDs.
 */
export const REQUEST_ID_LENGTH = 4;

/**
 * Length of spawn IDs (excluding the "spawn:" prefix).
 */
export const SPAWN_ID_LENGTH = 8;
