/**
 * AI command types
 */

/**
 * AI configuration with defaults
 */
export interface AIConfig {
    model: string;
    maxTurns: number;
    contextStrategy: 'none' | 'truncate' | 'summarize';
    maxTokens: number;
    promptCaching: boolean;
    markdownRendering: boolean;
    summaryPrompt: string;
}

export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string };

export type Message = {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
};

/** Context file path relative to home directory */
export const CONTEXT_FILE = '.ai/context.json';

/** Anthropic API endpoint */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
