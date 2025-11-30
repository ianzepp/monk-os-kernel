/**
 * TTY Module
 *
 * Core TTY session handling, command parsing, and filesystem integration.
 * Server implementations are in src/servers/ (telnet.ts, ssh.ts).
 */

// Types
export type {
    TTYStream,
    Session,
    AuthState,
    SessionMode,
    SessionState, // deprecated
    ParsedCommand,
    TTYConfig,
    WriteFunction,
} from './types.js';

export { createSession, generateSessionId, getDefaultMotd, DEFAULT_MOTD, TTY_CHARS } from './types.js';

// Parser
export { parseCommand, resolvePath } from './parser.js';

// Commands
export { commands } from './commands.js';
export type { CommandHandler } from './commands.js';

// FS Factory
export { createFS } from './fs-factory.js';

// Session Handler
export { handleInput, writeToStream, printPrompt, sendWelcome } from './session-handler.js';
