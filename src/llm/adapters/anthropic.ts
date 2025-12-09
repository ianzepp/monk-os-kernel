/**
 * Anthropic Adapter
 *
 * Handles Anthropic's Messages API format. This is the only provider using
 * this format - all others use OpenAI-compatible format.
 *
 * PROTOCOL DETAILS
 * ================
 * - Endpoint: /v1/messages
 * - Auth: x-api-key header (not Bearer token)
 * - Streaming: SSE with event types (message_start, content_block_delta, etc.)
 * - System prompt: Separate field, not in messages array
 *
 * MESSAGE FORMAT DIFFERENCES
 * ==========================
 * Anthropic uses content blocks instead of simple strings:
 * - OpenAI: { role: 'user', content: 'Hello' }
 * - Anthropic: { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
 *
 * STREAMING EVENT TYPES
 * =====================
 * - message_start: Contains message metadata
 * - content_block_start: New content block beginning
 * - content_block_delta: Incremental text
 * - content_block_stop: Content block complete
 * - message_delta: Final stats (stop_reason, usage)
 * - message_stop: Stream complete
 *
 * @module llm/adapters/anthropic
 */

import type { Channel } from '@src/hal/channel/types.js';
import type { Response } from '@src/message.js';
import type {
    LLMProvider,
    LLMModel,
    CompletionRequest,
    CompletionResponse,
    ChatRequest,
    ChatMessage,
    EmbeddingRequest,
    EmbeddingResponse,
    StreamChunk,
} from '../types.js';
import type { Adapter } from './types.js';

// =============================================================================
// ANTHROPIC-SPECIFIC TYPES
// =============================================================================

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
    type: 'text' | 'image';
    text?: string;
    source?: {
        type: 'base64';
        media_type: string;
        data: string;
    };
}

interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    system?: string;
    max_tokens: number;
    temperature?: number;
    stop_sequences?: string[];
    stream?: boolean;
}

interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}

interface AnthropicStreamEvent {
    type: string;
    index?: number;
    delta?: {
        type?: string;
        text?: string;
        stop_reason?: string;
    };
    content_block?: AnthropicContentBlock;
    message?: AnthropicResponse;
    usage?: {
        output_tokens: number;
    };
}

// =============================================================================
// ANTHROPIC ADAPTER
// =============================================================================

/**
 * Anthropic Messages API adapter.
 */
export class AnthropicAdapter implements Adapter {
    readonly name = 'anthropic';

    // Required header for Anthropic API
    private readonly anthropicVersion = '2023-06-01';

    // =========================================================================
    // COMPLETION (NON-STREAMING)
    // =========================================================================

    async complete(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: CompletionRequest,
    ): Promise<CompletionResponse> {
        const messages = this.buildMessagesFromPrompt(request.prompt);

        // Add system message if provided
        if (request.system) {
            messages.unshift({ role: 'system', content: request.system });
        }

        const chatRequest: ChatRequest = {
            model: request.model,
            messages,
            temperature: request.temperature,
            max_tokens: request.max_tokens,
            stop: request.stop,
            stream: false,
        };

        return this.chat(channel, provider, model, chatRequest);
    }

    // =========================================================================
    // COMPLETION (STREAMING)
    // =========================================================================

    async *completeStream(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: CompletionRequest,
    ): AsyncIterable<StreamChunk> {
        const messages = this.buildMessagesFromPrompt(request.prompt);

        // Add system message if provided
        if (request.system) {
            messages.unshift({ role: 'system', content: request.system });
        }

        const chatRequest: ChatRequest = {
            model: request.model,
            messages,
            temperature: request.temperature,
            max_tokens: request.max_tokens,
            stop: request.stop,
            stream: true,
        };

        yield* this.chatStream(channel, provider, model, chatRequest);
    }

    // =========================================================================
    // CHAT (NON-STREAMING)
    // =========================================================================

    async chat(
        channel: Channel,
        _provider: LLMProvider,
        model: LLMModel,
        request: ChatRequest,
    ): Promise<CompletionResponse> {
        const body = this.buildRequest(model, request, false);

        const responses = channel.handle({
            op: 'request',
            data: {
                method: 'POST',
                path: '/v1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    'anthropic-version': this.anthropicVersion,
                },
                body,
            },
        });

        for await (const response of responses) {
            if (response.op === 'ok') {
                const data = response.data as AnthropicResponse;
                return this.parseResponse(data, model);
            }

            if (response.op === 'error') {
                const err = response.data as { code?: string; message?: string };
                throw new Error(`Anthropic API error: ${err.code} - ${err.message}`);
            }
        }

        throw new Error('No response from Anthropic API');
    }

    // =========================================================================
    // CHAT (STREAMING)
    // =========================================================================

    async *chatStream(
        channel: Channel,
        _provider: LLMProvider,
        model: LLMModel,
        request: ChatRequest,
    ): AsyncIterable<StreamChunk> {
        const body = this.buildRequest(model, request, true);

        const responses = channel.handle({
            op: 'request',
            data: {
                method: 'POST',
                path: '/v1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    'anthropic-version': this.anthropicVersion,
                },
                body,
                accept: 'text/event-stream',
            },
        });

        for await (const response of responses) {
            if (response.op === 'event') {
                const chunk = this.parseStreamEvent(response, model);

                if (chunk) {
                    yield chunk;
                }
            }
            else if (response.op === 'error') {
                const err = response.data as { code?: string; message?: string };
                throw new Error(`Anthropic API error: ${err.code} - ${err.message}`);
            }
            else if (response.op === 'done') {
                return;
            }
        }
    }

    // =========================================================================
    // EMBEDDINGS
    // =========================================================================

    async embed(
        _channel: Channel,
        _provider: LLMProvider,
        _model: LLMModel,
        _request: EmbeddingRequest,
    ): Promise<EmbeddingResponse> {
        // Anthropic doesn't have an embeddings API
        throw new Error('Anthropic does not support embeddings. Use a different provider.');
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Build chat messages from a simple prompt.
     *
     * Note: System prompt is handled separately - caller adds it to messages.
     */
    private buildMessagesFromPrompt(prompt: string): ChatMessage[] {
        return [{ role: 'user', content: prompt }];
    }

    /**
     * Build Anthropic Messages API request body.
     */
    private buildRequest(
        model: LLMModel,
        request: ChatRequest,
        stream: boolean,
    ): AnthropicRequest {
        // Extract system message if present
        let system: string | undefined;
        const messages: AnthropicMessage[] = [];

        for (const msg of request.messages) {
            if (msg.role === 'system') {
                system = msg.content;
            }
            else {
                messages.push({
                    role: msg.role as 'user' | 'assistant',
                    content: msg.content,
                });
            }
        }

        return {
            model: model.model_id,
            messages,
            system,
            max_tokens: request.max_tokens ?? model.max_output,
            temperature: request.temperature,
            stop_sequences: request.stop,
            stream,
        };
    }

    /**
     * Parse non-streaming response.
     */
    private parseResponse(data: AnthropicResponse, model: LLMModel): CompletionResponse {
        // Extract text from content blocks
        let text = '';

        for (const block of data.content) {
            if (block.type === 'text' && block.text) {
                text += block.text;
            }
        }

        if (model.strip_markdown) {
            text = this.stripMarkdown(text);
        }

        return {
            text,
            model: data.model,
            usage: {
                prompt_tokens: data.usage.input_tokens,
                completion_tokens: data.usage.output_tokens,
                total_tokens: data.usage.input_tokens + data.usage.output_tokens,
            },
            finish_reason: this.mapStopReason(data.stop_reason),
        };
    }

    /**
     * Parse streaming event into StreamChunk.
     */
    private parseStreamEvent(response: Response, _model: LLMModel): StreamChunk | null {
        const event = response.data as { type?: string; data?: AnthropicStreamEvent };
        const data = event.data;

        if (!data) {
            return null;
        }

        switch (data.type) {
            case 'content_block_delta':
                // Incremental text
                if (data.delta?.type === 'text_delta' && data.delta.text) {
                    return {
                        text: data.delta.text,
                        done: false,
                    };
                }
                break;

            case 'message_delta':
                // Final message with stop reason
                if (data.delta?.stop_reason) {
                    return {
                        text: '',
                        done: true,
                        finish_reason: this.mapStopReason(data.delta.stop_reason),
                    };
                }
                break;

            case 'message_stop':
                // Stream complete
                return {
                    text: '',
                    done: true,
                    finish_reason: 'stop',
                };
        }

        return null;
    }

    /**
     * Map Anthropic stop_reason to our finish_reason.
     */
    private mapStopReason(
        reason: string | null | undefined,
    ): 'stop' | 'length' | 'tool_calls' {
        switch (reason) {
            case 'max_tokens':
                return 'length';
            case 'tool_use':
                return 'tool_calls';
            default:
                return 'stop';
        }
    }

    /**
     * Strip markdown code fences from text.
     */
    private stripMarkdown(text: string): string {
        return text.replace(/```[\w]*\n?([\s\S]*?)\n?```/g, '$1').trim();
    }
}
