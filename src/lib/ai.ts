/**
 * AI Service
 *
 * Centralized AI capabilities for the system.
 * Provides simple prompting and agentic execution with tool use.
 */

import type { System } from './system.js';
import type { Session } from './tty/types.js';
import { executeLine } from './tty/executor.js';
import { applySessionMounts } from './tty/profile.js';
import { resolvePath } from './tty/parser.js';
import { runTransaction } from './transaction.js';
import { PassThrough } from 'node:stream';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for AI requests
 */
export interface AIOptions {
    /** Model to use (defaults to claude-sonnet-4-20250514) */
    model?: string;
    /** Maximum tokens in response */
    maxTokens?: number;
    /** System prompt */
    systemPrompt?: string;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}

/**
 * Options for agent execution
 */
export interface AgentOptions extends AIOptions {
    /** Maximum agentic turns (default: 20) */
    maxTurns?: number;
    /** Additional tools beyond built-in shell/fs tools */
    tools?: Tool[];
    /** Initial message history (for continuing conversations) */
    messages?: Message[];
    /** Enable prompt caching (adds anthropic-beta header) */
    promptCaching?: boolean;
}

/**
 * Tool definition (Anthropic format)
 */
export interface Tool {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

/**
 * Raw content block from Anthropic API
 */
export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string };

/**
 * Message in conversation
 */
export type Message = {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
};

/**
 * Events yielded by agent execution
 */
export type AgentEvent =
    | { type: 'text'; content: string }
    | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; id: string; name: string; output: string; exitCode?: number }
    | { type: 'error'; message: string }
    | { type: 'done'; success: boolean; messages?: Message[] };

// =============================================================================
// Built-in Tools
// =============================================================================

const SHELL_TOOLS: Tool[] = [
    {
        name: 'run_command',
        description:
            'Execute a shell command and return the output. Use this to explore the filesystem, query data, run utilities, etc. Do NOT use this for reading or writing files - use read_file and write_file instead.',
        input_schema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command to execute (e.g., "ls -la", "select * from users", "ps")',
                },
            },
            required: ['command'],
        },
    },
    {
        name: 'read_file',
        description: 'Read the contents of a file. Use this instead of cat or run_command for reading files.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The file path to read (absolute or relative to current directory)',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description:
            'Write content to a file. Creates the file if it does not exist, overwrites if it does. Use this instead of echo/redirect for writing files.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The file path to write (absolute or relative to current directory)',
                },
                content: {
                    type: 'string',
                    description: 'The content to write to the file',
                },
            },
            required: ['path', 'content'],
        },
    },
];

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TURNS = 20;

// =============================================================================
// AI Class
// =============================================================================

/**
 * AI service providing prompting and agentic capabilities
 *
 * Usage:
 *   // Simple prompt
 *   const response = await system.ai.prompt('Summarize this text...');
 *
 *   // Agent with tool execution
 *   for await (const event of system.ai.agent(session, 'List all users')) {
 *       if (event.type === 'text') console.log(event.content);
 *   }
 */
export class AI {
    constructor(private system: System) {}

    /**
     * Get API key from environment
     */
    private getApiKey(): string {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('ANTHROPIC_API_KEY not configured');
        }
        return apiKey;
    }

    /**
     * Simple prompt → text response
     *
     * Use for summarization, analysis, or any non-agentic task.
     */
    async prompt(prompt: string, options?: AIOptions): Promise<string> {
        const apiKey = this.getApiKey();
        const model = options?.model || DEFAULT_MODEL;
        const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;

        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                system: options?.systemPrompt,
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: options?.signal,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`AI API error ${response.status}: ${error}`);
        }

        const result = (await response.json()) as { content: ContentBlock[] };
        const textBlock = result.content.find(
            (b): b is { type: 'text'; text: string } => b.type === 'text'
        );

        return textBlock?.text || '';
    }

    /**
     * Execute agent with shell/fs tool capabilities
     *
     * Yields events as they occur for real-time progress.
     * The agent can execute shell commands and read/write files
     * within the session's virtual environment.
     *
     * @param session - Shell session for command/file context
     * @param prompt - User prompt (added to message history)
     * @param options - Agent options including optional message history
     */
    async *agent(
        session: Session,
        prompt: string,
        options?: AgentOptions
    ): AsyncGenerator<AgentEvent> {
        const apiKey = this.getApiKey();
        const model = options?.model || DEFAULT_MODEL;
        const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;
        const maxTurns = options?.maxTurns || DEFAULT_MAX_TURNS;

        // Combine built-in tools with any custom tools
        const tools = [...SHELL_TOOLS, ...(options?.tools || [])];

        // Start with existing messages or empty, then add user prompt
        const messages: Message[] = options?.messages
            ? [...options.messages, { role: 'user', content: prompt }]
            : [{ role: 'user', content: prompt }];

        let turns = 0;
        let continueLoop = true;

        while (continueLoop && turns < maxTurns) {
            continueLoop = false;
            turns++;

            try {
                // Build headers
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                };
                if (options?.promptCaching) {
                    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
                }

                const response = await fetch(ANTHROPIC_API_URL, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        max_tokens: maxTokens,
                        system: options?.systemPrompt,
                        messages,
                        tools,
                    }),
                    signal: options?.signal,
                });

                if (!response.ok) {
                    const error = await response.text();
                    yield { type: 'error', message: `API error ${response.status}: ${error}` };
                    yield { type: 'done', success: false };
                    return;
                }

                const result = (await response.json()) as {
                    content: ContentBlock[];
                    stop_reason: string;
                };

                // Process response
                const assistantContent: ContentBlock[] = [];
                const toolResults: ContentBlock[] = [];

                for (const block of result.content) {
                    if (block.type === 'text') {
                        assistantContent.push(block);
                        yield { type: 'text', content: block.text };
                    } else if (block.type === 'tool_use') {
                        assistantContent.push(block);

                        // Emit tool_call event
                        yield {
                            type: 'tool_call',
                            id: block.id,
                            name: block.name,
                            input: block.input,
                        };

                        // Execute tool
                        const toolResult = await this.executeTool(session, block.name, block.input);

                        // Emit tool_result event
                        yield {
                            type: 'tool_result',
                            id: block.id,
                            name: block.name,
                            output: toolResult.output,
                            exitCode: toolResult.exitCode,
                        };

                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: toolResult.output,
                        });
                    }
                }

                // Add assistant message
                messages.push({ role: 'assistant', content: assistantContent });

                // If there were tool uses, continue loop
                if (toolResults.length > 0) {
                    messages.push({ role: 'user', content: toolResults });
                    continueLoop = true;
                }
            } catch (err) {
                // Check for abort
                if (err instanceof Error && err.name === 'AbortError') {
                    yield { type: 'error', message: 'Request aborted' };
                    yield { type: 'done', success: false };
                    return;
                }

                const message = err instanceof Error ? err.message : String(err);
                yield { type: 'error', message };
                yield { type: 'done', success: false, messages };
                return;
            }
        }

        yield { type: 'done', success: true, messages };
    }

    /**
     * Execute a tool and return the result
     */
    private async executeTool(
        session: Session,
        name: string,
        input: Record<string, unknown>
    ): Promise<{ output: string; exitCode?: number }> {
        switch (name) {
            case 'run_command': {
                const command = input.command as string;
                return this.executeCommand(session, command);
            }

            case 'read_file': {
                const path = input.path as string;
                return this.readFile(session, path);
            }

            case 'write_file': {
                const path = input.path as string;
                const content = input.content as string;
                return this.writeFile(session, path, content);
            }

            default:
                return { output: `Unknown tool: ${name}` };
        }
    }

    /**
     * Execute a shell command
     */
    private async executeCommand(
        session: Session,
        command: string
    ): Promise<{ output: string; exitCode: number }> {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        stdin.end();

        const io = { stdin, stdout, stderr };
        let output = '';

        stdout.on('data', (chunk) => {
            output += chunk.toString();
        });
        stderr.on('data', (chunk) => {
            output += chunk.toString();
        });

        try {
            const exitCode = await executeLine(session, command, io, {
                addToHistory: false,
                useTransaction: true,
            });

            const finalOutput = exitCode !== 0
                ? `${output || '[No output]'}\n[Exit code: ${exitCode}]`
                : output || '[No output]';

            return { output: finalOutput, exitCode };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { output: `Error: ${message}`, exitCode: 1 };
        }
    }

    /**
     * Read a file from the virtual filesystem
     */
    private async readFile(
        session: Session,
        path: string
    ): Promise<{ output: string; exitCode?: number }> {
        if (!session.systemInit) {
            return { output: '[Error: filesystem not available]' };
        }

        const resolved = resolvePath(session.cwd, path);

        try {
            const content = await runTransaction(session.systemInit, async (system) => {
                applySessionMounts(session, system.fs, system);
                const data = await system.fs.read(resolved);
                return data.toString();
            });
            return { output: content };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `[Error: ${msg}]` };
        }
    }

    /**
     * Write a file to the virtual filesystem
     */
    private async writeFile(
        session: Session,
        path: string,
        content: string
    ): Promise<{ output: string; exitCode?: number }> {
        if (!session.systemInit) {
            return { output: '[Error: filesystem not available]' };
        }

        const resolved = resolvePath(session.cwd, path);

        try {
            await runTransaction(session.systemInit, async (system) => {
                applySessionMounts(session, system.fs, system);
                await system.fs.write(resolved, content);
            });
            return { output: `Wrote ${content.length} bytes to ${resolved}` };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `[Error: ${msg}]` };
        }
    }
}
