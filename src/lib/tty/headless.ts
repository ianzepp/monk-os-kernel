/**
 * Headless TTY Agent
 *
 * Provides TTY agent capabilities without a terminal stream.
 * Used by MCP server and HTTP API for programmatic AI access.
 */

import type { Session } from './types.js';
import type { SystemInit } from '@src/lib/system.js';
import type { AgentEvent } from '@src/lib/ai.js';
import { createSession, generateSessionId } from './types.js';
import { runTransaction } from '@src/lib/transaction.js';
import { applySessionMounts } from './profile.js';
import { loadSTMFull, formatAlarmsForPrompt } from './memory.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '@src/lib/constants.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Agent response structure (for non-streaming)
 */
export interface AgentResponse {
    success: boolean;
    response: string;
    toolCalls?: {
        name: string;
        input: Record<string, unknown>;
        output: string;
    }[];
    error?: string;
}

/**
 * Streaming event types (re-export compatible with existing consumers)
 */
export type AgentStreamEvent =
    | { type: 'tool_call'; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; name: string; output: string; exitCode?: number }
    | { type: 'text'; content: string }
    | { type: 'error'; message: string }
    | { type: 'done'; success: boolean };

// =============================================================================
// Agent Prompts
// =============================================================================

// Cache for agent prompt
let _agentPrompt: string | null = null;

function getAgentPrompt(): string {
    if (_agentPrompt === null) {
        try {
            _agentPrompt = readFileSync(
                join(getProjectRoot(), 'monkfs', 'etc', 'agents', 'ai'),
                'utf-8'
            );
        } catch {
            _agentPrompt = 'You are an AI assistant with access to a database shell.';
        }
    }
    return _agentPrompt;
}

// Cache for custom commands
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
// Session Management
// =============================================================================

/**
 * Session cache for headless sessions
 * Key: sessionId (from MCP or generated)
 */
const sessionCache = new Map<string, Session>();

/**
 * Create or retrieve a headless session
 */
export function getOrCreateHeadlessSession(
    systemInit: SystemInit,
    sessionId?: string
): Session {
    const id = sessionId || generateSessionId();

    // Check cache
    const cached = sessionCache.get(id);
    if (cached && cached.systemInit) {
        return cached;
    }

    // Create new session
    const session = createSession(id);
    session.systemInit = systemInit;
    session.authenticated = true;
    session.username = systemInit.username || 'root';
    session.tenant = systemInit.tenant;
    session.mode = 'ai';

    // Set environment
    const home = `/home/${session.username}`;
    session.env['USER'] = session.username;
    session.env['TENANT'] = session.tenant;
    session.env['ACCESS'] = systemInit.access;
    session.env['HOME'] = home;
    session.cwd = home;

    // Cache session
    sessionCache.set(id, session);

    return session;
}

/**
 * Clear cached session
 */
export function clearHeadlessSession(sessionId: string): void {
    sessionCache.delete(sessionId);
}

// =============================================================================
// System Prompt Building
// =============================================================================

/**
 * Build system prompt for headless agent
 */
async function buildSystemPrompt(session: Session): Promise<string> {
    const parts: string[] = [];

    // Base agent prompt
    parts.push(getAgentPrompt());

    // Custom commands
    const customCommands = getCustomCommands();
    if (customCommands.length > 0) {
        parts.push('\n# Custom Commands\n');
        for (const cmd of customCommands) {
            parts.push(cmd.content);
        }
    }

    // Session context
    parts.push(`
Session context:
- Working directory: ${session.cwd}
- User: ${session.username}
- Tenant: ${session.tenant}
`);

    // Include STM contents if available
    const stmData = await loadSTMFull(session);
    const stmEntries = Object.entries(stmData.entries);

    if (stmEntries.length > 0 || stmData.alarms.length > 0) {
        let stmSection = 'Current short-term memory (STM):';

        if (stmEntries.length > 0) {
            stmSection += `\n${stmEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
        }

        if (stmData.alarms.length > 0) {
            const alarmText = formatAlarmsForPrompt(stmData.alarms);
            if (alarmText) {
                stmSection += `\n\nPending alarms:\n${alarmText}`;
            }
        }

        parts.push(stmSection);
    }

    return parts.join('\n');
}

// =============================================================================
// Agent Execution
// =============================================================================

/**
 * Execute AI agent with a prompt
 *
 * This is the main entry point for headless AI access.
 */
export async function executeAgentPrompt(
    systemInit: SystemInit,
    prompt: string,
    options?: {
        sessionId?: string;
        maxTurns?: number;
    }
): Promise<AgentResponse> {
    const session = getOrCreateHeadlessSession(systemInit, options?.sessionId);

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(session);

    const toolCalls: { name: string; input: Record<string, unknown>; output: string }[] = [];
    let responseText = '';
    let success = true;
    let error: string | undefined;

    try {
        // Use system.ai.agent() via transaction
        await runTransaction(systemInit, async (system) => {
            applySessionMounts(session, system.fs, system);

            for await (const event of system.ai.agent(session, prompt, {
                systemPrompt,
                maxTurns: options?.maxTurns,
            })) {
                switch (event.type) {
                    case 'text':
                        responseText += (responseText ? '\n' : '') + event.content;
                        break;
                    case 'tool_call':
                        // Will be paired with tool_result
                        break;
                    case 'tool_result':
                        toolCalls.push({
                            name: event.name,
                            input: {}, // Input was in tool_call event
                            output: event.output,
                        });
                        break;
                    case 'error':
                        error = event.message;
                        success = false;
                        break;
                    case 'done':
                        success = event.success;
                        break;
                }
            }
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            response: responseText,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            error: message,
        };
    }

    return {
        success,
        response: responseText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        error,
    };
}

/**
 * Execute AI agent with streaming events
 *
 * Yields events as they occur for real-time progress updates.
 */
export async function* executeAgentPromptStream(
    systemInit: SystemInit,
    prompt: string,
    options?: {
        sessionId?: string;
        maxTurns?: number;
    }
): AsyncGenerator<AgentStreamEvent> {
    const session = getOrCreateHeadlessSession(systemInit, options?.sessionId);

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(session);

    // Track tool calls for pairing with results
    const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

    try {
        // Use system.ai.agent() via transaction
        // Note: We collect events inside the transaction and yield after
        // because generators can't yield across async boundaries in some cases
        const events: AgentStreamEvent[] = [];

        await runTransaction(systemInit, async (system) => {
            applySessionMounts(session, system.fs, system);

            for await (const event of system.ai.agent(session, prompt, {
                systemPrompt,
                maxTurns: options?.maxTurns,
            })) {
                // Convert AgentEvent to AgentStreamEvent
                switch (event.type) {
                    case 'text':
                        events.push({ type: 'text', content: event.content });
                        break;
                    case 'tool_call':
                        pendingToolCalls.set(event.id, { name: event.name, input: event.input });
                        events.push({ type: 'tool_call', name: event.name, input: event.input });
                        break;
                    case 'tool_result':
                        events.push({
                            type: 'tool_result',
                            name: event.name,
                            output: event.output,
                            exitCode: event.exitCode,
                        });
                        break;
                    case 'error':
                        events.push({ type: 'error', message: event.message });
                        break;
                    case 'done':
                        events.push({ type: 'done', success: event.success });
                        break;
                }
            }
        });

        // Yield collected events
        for (const event of events) {
            yield event;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message };
        yield { type: 'done', success: false };
    }
}
