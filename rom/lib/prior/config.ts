/**
 * Prior Configuration - Constants and defaults for the Prior AI process
 *
 * PURPOSE
 * =======
 * Centralizes all configuration constants used by Prior. This includes
 * network settings, file paths, and operational limits.
 *
 * DESIGN RATIONALE
 * ================
 * Constants are grouped by concern:
 * - Network: TCP port, timeouts
 * - AI: Model defaults, iteration limits
 * - Paths: File system locations for prompts, memory, logs
 *
 * @module rom/lib/prior/config
 */

// =============================================================================
// NETWORK CONFIGURATION
// =============================================================================

/**
 * Default TCP port for the Prior HTTP server.
 * WHY 7777: Memorable, unlikely to conflict with common services.
 */
export const DEFAULT_PORT = 7777;

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
export const SYSTEM_PROMPT_PATH = '/etc/prior/system.txt';

/**
 * Path to the help text file.
 */
export const HELP_PATH = '/etc/prior/help.txt';

/**
 * Directory for Prior's persistent memory.
 */
export const MEMORY_DIR = '/var/prior';

/**
 * Path to the identity file (Prior's self-description).
 */
export const IDENTITY_PATH = '/var/prior/identity.txt';

/**
 * Path to the session log file.
 */
export const SESSION_LOG_PATH = '/var/prior/session.log';

/**
 * Path to the memory context file.
 */
export const CONTEXT_PATH = '/var/prior/context.txt';

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
