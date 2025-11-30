/**
 * AI interaction modes - oneshot and conversation
 */

import type { Session, CommandIO } from '../../types.js';
import type { FS } from '@src/lib/fs/index.js';
import type { Message, ContentBlock } from './types.js';
import { ANTHROPIC_API_URL } from './types.js';
import { loadConfig, loadUserConfig, applyConfig, loadContext, saveContext, applyContextStrategy } from './state.js';
import { buildSystemPrompt, streamResponse } from './api.js';
import { TOOLS, executeCommandCapture } from './tools.js';
import { renderMarkdown } from '../glow.js';
import { resolvePath } from '../../parser.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '@src/lib/constants.js';
import { PassThrough } from 'node:stream';

/**
 * One-shot mode: answer a single question
 */
export async function oneShotMode(
    session: Session,
    apiKey: string,
    prompt: string,
    stdinContent: string,
    io: CommandIO
): Promise<number> {
    // Load configuration
    const homeDir = `/home/${session.username}`;
    const config = loadConfig();

    // Build user message
    let userMessage = '';

    if (stdinContent) {
        userMessage += `<input>\n${stdinContent}</input>\n\n`;
    }

    if (prompt) {
        userMessage += prompt;
    } else {
        userMessage += 'Analyze this data.';
    }

    // Build system prompt with session context
    const systemPrompt = await buildSystemPrompt(session, false);

    // Build headers based on config
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    };
    if (config.promptCaching) {
        headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }

    // Build system prompt (with or without caching)
    const systemPayload = config.promptCaching
        ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
        : systemPrompt;

    try {
        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: config.model,
                max_tokens: config.maxTokens,
                stream: true,
                system: systemPayload,
                messages: [
                    {
                        role: 'user',
                        content: userMessage,
                    },
                ],
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            io.stderr.write(`ai: API error: ${response.status} ${error}\n`);
            return 1;
        }

        if (!response.body) {
            io.stderr.write('ai: no response body\n');
            return 1;
        }

        await streamResponse(response.body, io);
        io.stdout.write('\n');
        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        io.stderr.write(`ai: ${message}\n`);
        return 1;
    }
}

/**
 * Conversation mode: interactive chat with tool use
 * Reads from stdin for user input
 */
export async function conversationMode(
    session: Session,
    fs: FS | null,
    apiKey: string,
    io: CommandIO
): Promise<number> {
    io.stdout.write('Entering AI conversation mode. Type "exit" or Ctrl+D to return to shell.\n');

    const homeDir = `/home/${session.username}`;

    // Load configuration (system + user overrides)
    const config = loadConfig();
    const userConfig = await loadUserConfig(fs, homeDir);
    applyConfig(config, userConfig);

    // List loaded agent configuration files
    const agentsDir = join(getProjectRoot(), 'monkfs', 'etc', 'agents');
    try {
        const files = readdirSync(agentsDir).sort();
        for (const file of files) {
            io.stdout.write(`  - /etc/agents/${file}\n`);
        }
    } catch {
        // Directory doesn't exist or not readable
    }

    // Show user config if present
    if (Object.keys(userConfig).length > 0) {
        io.stdout.write(`  - ~/.ai/config\n`);
    }

    // Load previous conversation context
    let messages: Message[] = await loadContext(fs, homeDir);

    if (messages.length > 0) {
        io.stdout.write(`  - ~/.ai/context.json (${messages.length} messages)\n`);
    }

    io.stdout.write('\n');

    const systemPrompt = await buildSystemPrompt(session, true);

    // Show initial prompt
    io.stdout.write('\x1b[36m@>\x1b[0m ');

    // Read lines from stdin
    for await (const line of readLines(io.stdin, io.signal)) {
        const trimmed = line.trim();

        // Exit commands
        if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
            // Save context before exiting
            await saveContext(fs, homeDir, messages);
            if (messages.length > 0) {
                io.stdout.write('\x1b[2mContext saved to ~/.ai/context.json\x1b[0m\n');
            }
            break;
        }

        // Add user message
        messages.push({ role: 'user', content: trimmed });

        // Apply sliding window if needed
        messages = await applyContextStrategy(messages, config, apiKey, systemPrompt);

        // Chat loop with potential tool use
        let continueLoop = true;
        while (continueLoop) {
            continueLoop = false;

            // Build headers based on config
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            };
            if (config.promptCaching) {
                headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
            }

            // Build system prompt (with or without caching)
            const systemPayload = config.promptCaching
                ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
                : systemPrompt;

            try {
                const response = await fetch(ANTHROPIC_API_URL, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: config.model,
                        max_tokens: config.maxTokens,
                        system: systemPayload,
                        messages,
                        tools: TOOLS,
                    }),
                });

                if (!response.ok) {
                    const error = await response.text();
                    io.stderr.write(`ai: API error: ${response.status} ${error}\n`);
                    break;
                }

                const result = await response.json() as {
                    content: ContentBlock[];
                    stop_reason: string;
                };

                // Process response content
                const assistantContent: ContentBlock[] = [];
                const toolResults: ContentBlock[] = [];

                for (const block of result.content) {
                    if (block.type === 'text') {
                        assistantContent.push(block);
                        io.stdout.write(config.markdownRendering ? renderMarkdown(block.text) : block.text);
                    } else if (block.type === 'tool_use') {
                        assistantContent.push(block);

                        if (block.name === 'run_command') {
                            const cmd = (block.input as { command: string }).command;
                            io.stdout.write(`\n\x1b[36m\u25cf\x1b[0m run_command(${cmd})\n`);

                            // Execute the command
                            const output = await executeCommandCapture(session, fs, cmd, io);

                            // Show result summary
                            const lines = output.split('\n').filter(l => l.trim()).length;
                            const chars = output.length;
                            io.stdout.write(`  \x1b[2m\u23bf\x1b[0m  ${lines} lines, ${chars} chars\n\n`);

                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: block.id,
                                content: output,
                            });
                        } else if (block.name === 'read_file') {
                            const path = (block.input as { path: string }).path;
                            const resolved = resolvePath(session.cwd, path);
                            io.stdout.write(`\n\x1b[36m\u25cf\x1b[0m read_file(${resolved})\n`);

                            let output: string;
                            try {
                                if (!fs) {
                                    output = '[Error: filesystem not available]';
                                } else {
                                    const data = await fs.read(resolved);
                                    output = data.toString();
                                }
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                output = `[Error: ${msg}]`;
                            }

                            // Show result summary
                            const lines = output.split('\n').length;
                            const chars = output.length;
                            io.stdout.write(`  \x1b[2m\u23bf\x1b[0m  ${lines} lines, ${chars} chars\n\n`);

                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: block.id,
                                content: output,
                            });
                        } else if (block.name === 'write_file') {
                            const { path, content } = block.input as { path: string; content: string };
                            const resolved = resolvePath(session.cwd, path);
                            io.stdout.write(`\n\x1b[36m\u25cf\x1b[0m write_file(${resolved})\n`);

                            let output: string;
                            try {
                                if (!fs) {
                                    output = '[Error: filesystem not available]';
                                } else {
                                    await fs.write(resolved, content);
                                    output = `Wrote ${content.length} bytes to ${resolved}`;
                                }
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                output = `[Error: ${msg}]`;
                            }

                            io.stdout.write(`  \x1b[2m\u23bf\x1b[0m  ${output}\n\n`);

                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: block.id,
                                content: output,
                            });
                        }
                    }
                }

                // Add assistant message
                messages.push({ role: 'assistant', content: assistantContent });

                // If there were tool uses, add results and continue
                if (toolResults.length > 0) {
                    messages.push({ role: 'user', content: toolResults });
                    continueLoop = true;
                } else {
                    io.stdout.write('\n\n');
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : 'unknown error';
                io.stderr.write(`ai: ${message}\n`);
                break;
            }
        }

        // Show prompt for next input
        io.stdout.write('\x1b[36m@>\x1b[0m ');
    }

    return 0;
}

/**
 * Async generator that yields lines from stdin
 */
async function* readLines(
    stdin: PassThrough,
    signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
    let buffer = '';

    for await (const chunk of stdin) {
        if (signal?.aborted) return;

        buffer += chunk.toString();

        // Yield complete lines
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            yield buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
        }
    }

    // Yield remaining data if any
    if (buffer) {
        yield buffer;
    }
}
