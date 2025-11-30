/**
 * TTY AI Mode
 *
 * Handles AI-first interaction mode where AI is the primary interface.
 * Users can escape to shell via '!' or '! cmd'.
 */

import type { Session, TTYStream } from './types.js';
import type { Message } from '@src/lib/ai.js';
import { TTY_CHARS } from './types.js';
import { enterShellMode } from './shell-mode.js';
import { saveHistory } from './profile.js';
import { loadSTMFull, formatAlarmsForPrompt } from './memory.js';
import { renderMarkdown } from './commands/glow.js';
import { runTransaction } from '@src/lib/transaction.js';
import { applySessionMounts } from './profile.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '@src/lib/constants.js';

// =============================================================================
// Configuration
// =============================================================================

/**
 * AI configuration with defaults
 */
interface AIConfig {
    model: string;
    maxTurns: number;
    contextStrategy: 'none' | 'truncate' | 'summarize';
    maxTokens: number;
    promptCaching: boolean;
    markdownRendering: boolean;
    summaryPrompt: string;
}

const DEFAULT_CONFIG: AIConfig = {
    model: 'claude-sonnet-4-20250514',
    maxTurns: 20,
    contextStrategy: 'summarize',
    maxTokens: 4096,
    promptCaching: true,
    markdownRendering: true,
    summaryPrompt: 'Summarize the key points and decisions from this conversation in 2-3 sentences.',
};

// =============================================================================
// Agent Prompts
// =============================================================================

// Load agent prompts lazily from monkfs/etc/agents/
let _agentPromptBase: string | null = null;

function getAgentPromptBase(): string {
    if (_agentPromptBase === null) {
        try {
            _agentPromptBase = readFileSync(join(getProjectRoot(), 'monkfs', 'etc', 'agents', 'ai'), 'utf-8');
        } catch {
            _agentPromptBase = 'You are an AI assistant embedded in a Linux-like shell called monksh.';
        }
    }
    return _agentPromptBase;
}

// Cache for custom command help (each command as separate entry)
let _customCommands: { name: string; content: string }[] | null = null;

function getCustomCommands(): { name: string; content: string }[] {
    if (_customCommands === null) {
        _customCommands = [];
        try {
            const commandsDir = join(getProjectRoot(), 'monkfs', 'etc', 'agents', 'commands');
            const files = readdirSync(commandsDir).sort();

            for (const file of files) {
                try {
                    const content = readFileSync(join(commandsDir, file), 'utf-8');
                    _customCommands.push({ name: file, content: content.trim() });
                } catch {
                    // Skip unreadable files
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }
    return _customCommands;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Write to TTY stream with CRLF
 */
function writeToStream(stream: TTYStream, text: string): void {
    const normalized = text.replace(/(?<!\r)\n/g, '\r\n');
    stream.write(normalized);
}

/**
 * Parse env-style config file content
 */
function parseConfig(content: string): Record<string, string> {
    const config: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            config[key] = value;
        }
    }
    return config;
}

/**
 * Load AI configuration from /etc/agents/ai.conf
 */
function loadConfig(): AIConfig {
    const config = { ...DEFAULT_CONFIG };

    try {
        const systemConf = readFileSync(
            join(getProjectRoot(), 'monkfs', 'etc', 'agents', 'ai.conf'),
            'utf-8'
        );
        applyConfig(config, parseConfig(systemConf));
    } catch {
        // Use defaults
    }

    return config;
}

/**
 * Apply parsed config values to AIConfig
 */
function applyConfig(config: AIConfig, values: Record<string, string>): void {
    if (values.MODEL) config.model = values.MODEL;
    if (values.MAX_TURNS) config.maxTurns = parseInt(values.MAX_TURNS, 10) || config.maxTurns;
    if (values.CONTEXT_STRATEGY) {
        const strategy = values.CONTEXT_STRATEGY.toLowerCase();
        if (strategy === 'none' || strategy === 'truncate' || strategy === 'summarize') {
            config.contextStrategy = strategy;
        }
    }
    if (values.MAX_TOKENS) config.maxTokens = parseInt(values.MAX_TOKENS, 10) || config.maxTokens;
    if (values.PROMPT_CACHING) config.promptCaching = values.PROMPT_CACHING.toLowerCase() === 'true';
    if (values.MARKDOWN_RENDERING) config.markdownRendering = values.MARKDOWN_RENDERING.toLowerCase() === 'true';
    if (values.SUMMARY_PROMPT) config.summaryPrompt = values.SUMMARY_PROMPT;
}

// =============================================================================
// Context Management
// =============================================================================

/** Context file path relative to home directory */
const CONTEXT_FILE = '.ai/context.json';

/** Context with metadata */
interface SavedContext {
    messages: Message[];
    savedAt?: string;
}

/**
 * Load saved conversation context from ~/.ai/context.json
 */
async function loadContext(session: Session): Promise<SavedContext> {
    if (!session.systemInit) return { messages: [] };

    const homeDir = `/home/${session.username}`;
    const contextPath = `${homeDir}/${CONTEXT_FILE}`;

    try {
        let result: SavedContext = { messages: [] };
        await runTransaction(session.systemInit, async (system) => {
            applySessionMounts(session, system.fs, system);
            try {
                const data = await system.fs.read(contextPath);
                const parsed = JSON.parse(data.toString());
                if (Array.isArray(parsed.messages)) {
                    result = {
                        messages: parsed.messages,
                        savedAt: parsed.savedAt,
                    };
                }
            } catch {
                // File doesn't exist or invalid JSON
            }
        });
        return result;
    } catch {
        return { messages: [] };
    }
}

/**
 * Save conversation context to ~/.ai/context.json
 */
async function saveContext(session: Session, messages: Message[]): Promise<void> {
    if (!session.systemInit || messages.length === 0) return;

    const homeDir = `/home/${session.username}`;
    const contextPath = `${homeDir}/${CONTEXT_FILE}`;
    const aiDir = `${homeDir}/.ai`;

    try {
        await runTransaction(session.systemInit, async (system) => {
            applySessionMounts(session, system.fs, system);
            try {
                await system.fs.stat(aiDir);
            } catch {
                await system.fs.mkdir(aiDir);
            }

            const context = {
                version: 1,
                savedAt: new Date().toISOString(),
                messageCount: messages.length,
                messages,
            };
            await system.fs.write(contextPath, JSON.stringify(context, null, 2));
        });
    } catch {
        // Silently fail
    }
}

/**
 * Clear saved context
 */
async function clearContext(session: Session): Promise<void> {
    if (!session.systemInit) return;

    const homeDir = `/home/${session.username}`;
    const contextPath = `${homeDir}/${CONTEXT_FILE}`;

    try {
        await runTransaction(session.systemInit, async (system) => {
            applySessionMounts(session, system.fs, system);
            try {
                await system.fs.unlink(contextPath);
            } catch {
                // File doesn't exist - that's fine
            }
        });
    } catch {
        // Silently fail
    }
}

/**
 * Format time ago string
 */
function formatTimeAgo(savedAt: string): string {
    const saved = new Date(savedAt);
    const now = new Date();
    const diffMs = now.getTime() - saved.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMins > 0) return `${diffMins}m ago`;
    return 'just now';
}

/**
 * Extract last topic from messages (truncated last user message)
 */
function extractLastTopic(messages: Message[]): string | null {
    // Find last user message
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'user') {
            const content = typeof msg.content === 'string'
                ? msg.content
                : msg.content
                    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                    .map(b => b.text)
                    .join(' ');
            // Truncate and clean
            const cleaned = content.replace(/\s+/g, ' ').trim();
            if (cleaned.length > 50) {
                return cleaned.slice(0, 47) + '...';
            }
            return cleaned || null;
        }
    }
    return null;
}

// =============================================================================
// System Prompt Building
// =============================================================================

/**
 * Build system prompt with STM contents
 */
async function buildSystemPrompt(session: Session): Promise<string> {
    const parts: string[] = [];

    // Base agent prompt
    parts.push(getAgentPromptBase());

    // Custom commands
    const customCommands = getCustomCommands();
    if (customCommands.length > 0) {
        parts.push('\n# Custom Commands\n\nThese commands are specific to monksh:');
        for (const cmd of customCommands) {
            parts.push(cmd.content);
        }
    }

    // Session context
    parts.push(`
Session context:
- Working directory: ${session.cwd}
- User: ${session.username}
- Tenant: ${session.tenant}`);

    // Inject shell transcript if available
    if (session.shellTranscript.length > 0) {
        parts.push(`\n\nRecent shell session:\n${session.shellTranscript.join('\n---\n')}`);
    }

    // Include STM contents if available
    const stmData = await loadSTMFull(session);
    const stmEntries = Object.entries(stmData.entries);

    if (stmEntries.length > 0 || stmData.alarms.length > 0) {
        let stmText = '\n\nCurrent short-term memory (STM):';

        if (stmEntries.length > 0) {
            stmText += `\n${stmEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
        }

        if (stmData.alarms.length > 0) {
            const alarmText = formatAlarmsForPrompt(stmData.alarms);
            if (alarmText) {
                stmText += `\n\nPending alarms:\n${alarmText}`;
            }
        }

        parts.push(stmText);
    }

    return parts.join('\n');
}

// =============================================================================
// Context Strategy
// =============================================================================

/**
 * Apply context strategy (sliding window) to messages
 */
async function applyContextStrategy(
    session: Session,
    messages: Message[],
    config: AIConfig
): Promise<Message[]> {
    const maxMessages = config.maxTurns * 2;

    if (messages.length <= maxMessages) {
        return messages;
    }

    switch (config.contextStrategy) {
        case 'none':
            return messages;

        case 'truncate':
            return messages.slice(-maxMessages);

        case 'summarize': {
            const oldMessages = messages.slice(0, -maxMessages);
            const recentMessages = messages.slice(-maxMessages);
            const summary = await summarizeMessages(session, oldMessages, config);
            return [
                { role: 'user', content: `[Previous conversation summary: ${summary}]` },
                { role: 'assistant', content: 'I understand the context from our previous conversation.' },
                ...recentMessages,
            ];
        }

        default:
            return messages;
    }
}

/**
 * Summarize a list of messages using the AI
 */
async function summarizeMessages(
    session: Session,
    messages: Message[],
    config: AIConfig
): Promise<string> {
    if (!session.systemInit) return 'Previous conversation context';

    const conversationText = messages
        .map(m => {
            const role = m.role === 'user' ? 'User' : 'Assistant';
            const content = typeof m.content === 'string'
                ? m.content
                : m.content
                    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                    .map(b => b.text)
                    .join('\n');
            return `${role}: ${content.slice(0, 500)}${content.length > 500 ? '...' : ''}`;
        })
        .join('\n\n');

    try {
        let summary = 'Previous conversation context';
        await runTransaction(session.systemInit, async (system) => {
            summary = await system.ai.prompt(
                `${config.summaryPrompt}\n\nConversation:\n${conversationText}`,
                {
                    model: config.model,
                    maxTokens: 500,
                    systemPrompt: 'You are a helpful assistant that summarizes conversations concisely.',
                }
            );
        });
        return summary;
    } catch {
        return 'Previous conversation context (summary unavailable)';
    }
}

/**
 * Generate a user-facing conversation summary
 */
async function generateConversationSummary(
    session: Session,
    messages: Message[],
    config: AIConfig
): Promise<string> {
    if (!session.systemInit) return 'Unable to generate summary';

    const conversationText = messages
        .map(m => {
            const role = m.role === 'user' ? 'User' : 'Assistant';
            const content = typeof m.content === 'string'
                ? m.content
                : m.content
                    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                    .map(b => b.text)
                    .join('\n');
            return `${role}: ${content.slice(0, 1000)}${content.length > 1000 ? '...' : ''}`;
        })
        .join('\n\n');

    try {
        let summary = 'Unable to generate summary';
        await runTransaction(session.systemInit, async (system) => {
            summary = await system.ai.prompt(
                `Summarize this conversation. Include:
- Main topics discussed
- Key decisions or conclusions reached
- Any pending questions or action items

Conversation:
${conversationText}`,
                {
                    model: config.model,
                    maxTokens: 1000,
                    systemPrompt: 'You provide clear, executive summaries of conversations. Be concise but comprehensive.',
                }
            );
        });
        return summary;
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return `Unable to generate summary: ${msg}`;
    }
}

// =============================================================================
// Session State
// =============================================================================

/** Session-level AI state */
interface AIState {
    config: AIConfig;
    messages: Message[];
    initialized: boolean;
    abortController: AbortController | null;
}

/** Map of session ID to AI state */
const aiStates = new Map<string, AIState>();

/**
 * Get or create AI state for a session
 */
function getAIState(session: Session): AIState {
    let state = aiStates.get(session.id);
    if (!state) {
        state = {
            config: loadConfig(),
            messages: [],
            initialized: false,
            abortController: null,
        };
        aiStates.set(session.id, state);
    }
    return state;
}

/**
 * Abort any in-progress AI request for a session
 */
export function abortAIRequest(sessionId: string): boolean {
    const state = aiStates.get(sessionId);
    if (state?.abortController) {
        state.abortController.abort();
        state.abortController = null;
        return true;
    }
    return false;
}

/**
 * Clean up AI state for a session
 */
export function cleanupAIState(sessionId: string): void {
    aiStates.delete(sessionId);
}

// =============================================================================
// Entry Points
// =============================================================================

/**
 * Enter AI mode (called after login)
 */
export async function enterAIMode(
    stream: TTYStream,
    session: Session
): Promise<void> {
    const state = getAIState(session);

    // Load context and user config
    if (!state.initialized && session.systemInit) {
        const savedContext = await loadContext(session);
        state.messages = savedContext.messages;

        // Load user config overrides
        try {
            await runTransaction(session.systemInit, async (system) => {
                applySessionMounts(session, system.fs, system);
                try {
                    const homeDir = `/home/${session.username}`;
                    const data = await system.fs.read(`${homeDir}/.ai/config`);
                    applyConfig(state.config, parseConfig(data.toString()));
                } catch {
                    // No user config
                }
            });
        } catch {
            // Ignore config load errors
        }

        state.initialized = true;

        // Show loaded context info with topic summary
        if (state.messages.length > 0 && savedContext.savedAt) {
            const timeAgo = formatTimeAgo(savedContext.savedAt);
            const topic = extractLastTopic(state.messages);
            const topicInfo = topic ? `\n  Last: "${topic}"` : '';
            writeToStream(stream, `\x1b[2mResuming conversation (${state.messages.length} messages, ${timeAgo})${topicInfo}\x1b[0m\n`);
            writeToStream(stream, `\x1b[2mType /new to start fresh\x1b[0m\n\n`);
        }
    }

    writeToStream(stream, TTY_CHARS.AI_PROMPT);
}

/**
 * Save AI context (called on exit/disconnect)
 */
export async function saveAIContext(session: Session): Promise<void> {
    const state = aiStates.get(session.id);
    if (!state || state.messages.length === 0) return;
    await saveContext(session, state.messages);
}

/**
 * Process AI input
 *
 * @returns false if session should close
 */
export async function processAIInput(
    stream: TTYStream,
    session: Session,
    line: string
): Promise<boolean> {
    const trimmed = line.trim();

    // Empty line - just print prompt
    if (!trimmed) {
        writeToStream(stream, TTY_CHARS.AI_PROMPT);
        return true;
    }

    // Shell escape: ! or !command
    if (trimmed === TTY_CHARS.SHELL_ESCAPE || trimmed.startsWith(TTY_CHARS.SHELL_ESCAPE)) {
        const cmd = trimmed.slice(TTY_CHARS.SHELL_ESCAPE.length).trim();
        await enterShellMode(stream, session, cmd || undefined);
        return true;
    }

    // Exit AI mode entirely
    if (trimmed === 'exit' || trimmed === 'quit') {
        await saveAIContext(session);
        await saveHistory(session);
        session.shouldClose = true;
        return false;
    }

    const state = getAIState(session);

    // Clear context and start fresh
    if (trimmed === '/new' || trimmed === '/clear') {
        state.messages = [];
        await clearContext(session);
        writeToStream(stream, 'Context cleared. Starting fresh.\n');
        writeToStream(stream, TTY_CHARS.AI_PROMPT);
        return true;
    }

    // Summarize current conversation
    if (trimmed === '/summary' || trimmed === '/summarize') {
        if (state.messages.length === 0) {
            writeToStream(stream, 'No conversation to summarize.\n');
            writeToStream(stream, TTY_CHARS.AI_PROMPT);
            return true;
        }

        writeToStream(stream, '\x1b[2mSummarizing conversation...\x1b[0m\n\n');
        const summary = await generateConversationSummary(session, state.messages, state.config);
        writeToStream(stream, summary + '\n\n');
        writeToStream(stream, TTY_CHARS.AI_PROMPT);
        return true;
    }

    // Check for API key
    if (!process.env.ANTHROPIC_API_KEY) {
        writeToStream(stream, 'Error: ANTHROPIC_API_KEY environment variable not set.\n');
        writeToStream(stream, 'Use ! to enter shell mode, or set the API key.\n');
        writeToStream(stream, TTY_CHARS.AI_PROMPT);
        return true;
    }

    // Process AI message
    await handleAIMessage(stream, session, trimmed);

    return true;
}

/**
 * Handle a single AI message
 */
async function handleAIMessage(
    stream: TTYStream,
    session: Session,
    message: string
): Promise<void> {
    if (!session.systemInit) {
        writeToStream(stream, 'Error: Session not initialized.\n');
        writeToStream(stream, TTY_CHARS.AI_PROMPT);
        return;
    }

    const state = getAIState(session);
    const systemPrompt = await buildSystemPrompt(session);

    // Apply sliding window if needed
    state.messages = await applyContextStrategy(session, state.messages, state.config);

    // Create abort controller for this request
    state.abortController = new AbortController();

    try {
        await runTransaction(session.systemInit, async (system) => {
            applySessionMounts(session, system.fs, system);

            // Debug: show outgoing request
            if (session.debugMode) {
                const debugInfo = {
                    model: state.config.model,
                    message: message.slice(0, 100) + (message.length > 100 ? '...' : ''),
                    contextSize: state.messages.length,
                };
                writeToStream(stream, `\n\x1b[33m-> ${JSON.stringify(debugInfo)}\x1b[0m\n`);
            }

            for await (const event of system.ai.agent(session, message, {
                model: state.config.model,
                maxTokens: state.config.maxTokens,
                maxTurns: state.config.maxTurns,
                systemPrompt,
                messages: state.messages,
                promptCaching: state.config.promptCaching,
                signal: state.abortController!.signal,
            })) {
                switch (event.type) {
                    case 'text': {
                        const text = state.config.markdownRendering
                            ? renderMarkdown(event.content)
                            : event.content;
                        writeToStream(stream, '\n' + text);
                        break;
                    }

                    case 'tool_call':
                        writeToStream(stream, `\n\x1b[36m\u25cf\x1b[0m ${event.name}(${formatToolInput(event.input)})\n`);
                        break;

                    case 'tool_result': {
                        if (event.exitCode !== undefined && event.exitCode !== 0) {
                            writeToStream(stream, `  \x1b[31m\u2717\x1b[0m  exit code ${event.exitCode}\n`);
                        } else {
                            const lines = event.output.split('\n').filter(l => l.trim()).length;
                            const chars = event.output.length;
                            writeToStream(stream, `  \x1b[2m\u23bf\x1b[0m  ${lines} lines, ${chars} chars\n`);
                        }
                        break;
                    }

                    case 'error':
                        writeToStream(stream, `\nAI error: ${event.message}\n`);
                        break;

                    case 'done':
                        // Update message history from the agent
                        if (event.messages) {
                            state.messages = event.messages;
                        }
                        break;
                }
            }
        });

        writeToStream(stream, '\n\n');
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            writeToStream(stream, '\n^C\n');
        } else {
            const errMessage = err instanceof Error ? err.message : 'unknown error';
            writeToStream(stream, `AI error: ${errMessage}\n`);
        }
    } finally {
        state.abortController = null;
    }

    // Clear shell transcript after it's been incorporated into AI context
    session.shellTranscript = [];

    writeToStream(stream, TTY_CHARS.AI_PROMPT);
}

/**
 * Format tool input for display
 */
function formatToolInput(input: Record<string, unknown>): string {
    if ('command' in input) return String(input.command);
    if ('path' in input) return String(input.path);
    return JSON.stringify(input);
}
