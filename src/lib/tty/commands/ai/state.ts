/**
 * AI configuration and context persistence
 */

import type { FS } from '@src/lib/fs/index.js';
import type { AIConfig, Message, ContentBlock } from './types.js';
import { CONTEXT_FILE, ANTHROPIC_API_URL } from './types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '@src/lib/constants.js';

export const DEFAULT_CONFIG: AIConfig = {
    model: 'claude-sonnet-4-20250514',
    maxTurns: 20,
    contextStrategy: 'summarize',
    maxTokens: 4096,
    promptCaching: true,
    markdownRendering: true,
    summaryPrompt: 'Summarize the key points and decisions from this conversation in 2-3 sentences.',
};

/**
 * Parse env-style config file content
 */
export function parseConfig(content: string): Record<string, string> {
    const config: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        // Skip comments and empty lines
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
 * Apply parsed config values to AIConfig
 */
export function applyConfig(config: AIConfig, values: Record<string, string>): void {
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

/**
 * Load AI configuration from /etc/agents/ai.conf
 */
export function loadConfig(): AIConfig {
    const config = { ...DEFAULT_CONFIG };

    // Load system config from /etc/agents/ai.conf
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
 * Load user config overrides from ~/.ai/config
 */
export async function loadUserConfig(fs: FS | null, homeDir: string): Promise<Record<string, string>> {
    if (!fs) return {};
    try {
        const data = await fs.read(`${homeDir}/.ai/config`);
        return parseConfig(data.toString());
    } catch {
        return {};
    }
}

/**
 * Load saved conversation context from ~/.ai/context.json
 */
export async function loadContext(fs: FS | null, homeDir: string): Promise<Message[]> {
    if (!fs) return [];

    const contextPath = `${homeDir}/${CONTEXT_FILE}`;
    try {
        const data = await fs.read(contextPath);
        const parsed = JSON.parse(data.toString());
        if (Array.isArray(parsed.messages)) {
            return parsed.messages;
        }
    } catch {
        // File doesn't exist or invalid JSON - start fresh
    }
    return [];
}

/**
 * Save conversation context to ~/.ai/context.json
 */
export async function saveContext(fs: FS | null, homeDir: string, messages: Message[]): Promise<void> {
    if (!fs || messages.length === 0) return;

    const contextPath = `${homeDir}/${CONTEXT_FILE}`;
    const aiDir = `${homeDir}/.ai`;

    try {
        // Ensure .ai directory exists
        try {
            await fs.stat(aiDir);
        } catch {
            await fs.mkdir(aiDir);
        }

        // Save context with metadata
        const context = {
            version: 1,
            savedAt: new Date().toISOString(),
            messageCount: messages.length,
            messages,
        };
        await fs.write(contextPath, JSON.stringify(context, null, 2));
    } catch {
        // Silently fail - don't interrupt exit
    }
}

/**
 * Apply context strategy (sliding window) to messages
 */
export async function applyContextStrategy(
    messages: Message[],
    config: AIConfig,
    apiKey: string,
    systemPrompt: string
): Promise<Message[]> {
    const maxMessages = config.maxTurns * 2; // Each turn = user + assistant

    if (messages.length <= maxMessages) {
        return messages;
    }

    switch (config.contextStrategy) {
        case 'none':
            // No limit - return all messages
            return messages;

        case 'truncate':
            // Simple truncation - keep most recent messages
            return messages.slice(-maxMessages);

        case 'summarize': {
            // Summarize old messages, keep recent ones
            const oldMessages = messages.slice(0, -maxMessages);
            const recentMessages = messages.slice(-maxMessages);

            // Generate summary of old messages
            const summary = await summarizeMessages(oldMessages, config, apiKey, systemPrompt);

            // Return summary + recent messages
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
    messages: Message[],
    config: AIConfig,
    apiKey: string,
    _systemPrompt: string
): Promise<string> {
    // Build a condensed view of the conversation
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
        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: config.model,
                max_tokens: 500,
                system: 'You are a helpful assistant that summarizes conversations concisely.',
                messages: [
                    {
                        role: 'user',
                        content: `${config.summaryPrompt}\n\nConversation:\n${conversationText}`,
                    },
                ],
            }),
        });

        if (!response.ok) {
            return 'Previous conversation context (summary unavailable)';
        }

        const result = await response.json() as { content: ContentBlock[] };
        const textBlock = result.content.find((b): b is { type: 'text'; text: string } => b.type === 'text');
        return textBlock?.text || 'Previous conversation context';
    } catch {
        return 'Previous conversation context (summary unavailable)';
    }
}
