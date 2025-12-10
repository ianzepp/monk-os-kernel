/**
 * OpenAI Adapter
 *
 * Handles OpenAI-compatible API format used by:
 * - OpenAI (api.openai.com)
 * - Ollama (localhost:11434)
 * - Together AI
 * - Groq
 * - vLLM
 * - LM Studio
 *
 * PROTOCOL DETAILS
 * ================
 * - Endpoint: /v1/chat/completions (chat), /v1/embeddings (embed)
 * - Streaming: SSE with `data: {...}` lines, terminated by `data: [DONE]`
 * - Auth: Bearer token in Authorization header
 *
 * OLLAMA SPECIFICS
 * ================
 * Ollama speaks OpenAI format at /v1/chat/completions but also has native
 * endpoints at /api/generate and /api/embeddings. We use OpenAI format for
 * consistency, but fall back to native for features not supported via OpenAI.
 *
 * Ollama streaming uses NDJSON (application/x-ndjson) not SSE, but the
 * HAL channel handles this transparently based on content-type.
 *
 * @module llm/adapters/openai
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
import type {
    Adapter,
    OpenAIMessage,
    OpenAIChatRequest,
    OpenAIChatResponse,
    OpenAIStreamChunk,
    OpenAIEmbeddingRequest,
    OpenAIEmbeddingResponse,
    OllamaGenerateRequest,
    OllamaGenerateResponse,
    OllamaEmbeddingRequest,
    OllamaEmbeddingResponse,
} from './types.js';

// =============================================================================
// OPENAI ADAPTER
// =============================================================================

/**
 * OpenAI-compatible adapter.
 *
 * Handles request/response translation for OpenAI API format.
 */
export class OpenAIAdapter implements Adapter {
    readonly name = 'openai';

    // =========================================================================
    // COMPLETION (NON-STREAMING)
    // =========================================================================

    async complete(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: CompletionRequest,
    ): Promise<CompletionResponse> {
        // Convert completion to chat format (OpenAI deprecated /v1/completions)
        const chatRequest: ChatRequest = {
            model: request.model,
            messages: this.buildMessagesFromPrompt(request.prompt, request.system),
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
        // Check if this is Ollama - use native endpoint for better streaming
        if (this.isOllama(provider)) {
            yield* this.ollamaGenerateStream(channel, model, request);

            return;
        }

        // For other OpenAI-compatible providers, use chat endpoint
        const chatRequest: ChatRequest = {
            model: request.model,
            messages: this.buildMessagesFromPrompt(request.prompt, request.system),
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
        const body = this.buildChatRequest(model, request, false);

        const responses = channel.handle({
            op: 'request',
            data: {
                method: 'POST',
                path: '/v1/chat/completions',
                headers: { 'Content-Type': 'application/json' },
                body,
            },
        });

        // Collect the response
        for await (const response of responses) {
            if (response.op === 'ok') {
                const data = response.data as OpenAIChatResponse;

                return this.parseCompletionResponse(data, model);
            }

            if (response.op === 'error') {
                const err = response.data as { code?: string; message?: string };

                throw new Error(`OpenAI API error: ${err.code} - ${err.message}`);
            }
        }

        throw new Error('No response from OpenAI API');
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
        const body = this.buildChatRequest(model, request, true);

        const responses = channel.handle({
            op: 'request',
            data: {
                method: 'POST',
                path: '/v1/chat/completions',
                headers: { 'Content-Type': 'application/json' },
                body,
                accept: 'text/event-stream',
            },
        });

        for await (const response of responses) {
            if (response.op === 'event') {
                const chunk = this.parseStreamEvent(response);

                if (chunk) {
                    yield chunk;
                }
            }
            else if (response.op === 'error') {
                const err = response.data as { code?: string; message?: string };

                throw new Error(`OpenAI API error: ${err.code} - ${err.message}`);
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
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: EmbeddingRequest,
    ): Promise<EmbeddingResponse> {
        // Ollama uses different endpoint for embeddings
        if (this.isOllama(provider)) {
            return this.ollamaEmbed(channel, model, request);
        }

        const body: OpenAIEmbeddingRequest = {
            model: model.model_id,
            input: request.input,
        };

        const responses = channel.handle({
            op: 'request',
            data: {
                method: 'POST',
                path: '/v1/embeddings',
                headers: { 'Content-Type': 'application/json' },
                body,
            },
        });

        for await (const response of responses) {
            if (response.op === 'ok') {
                const data = response.data as OpenAIEmbeddingResponse;

                return {
                    embeddings: data.data.map(d => d.embedding),
                    model: data.model,
                    usage: data.usage,
                };
            }

            if (response.op === 'error') {
                const err = response.data as { code?: string; message?: string };

                throw new Error(`OpenAI API error: ${err.code} - ${err.message}`);
            }
        }

        throw new Error('No response from OpenAI API');
    }

    // =========================================================================
    // OLLAMA-SPECIFIC METHODS
    // =========================================================================

    /**
     * Check if provider is Ollama (uses different endpoints).
     */
    private isOllama(provider: LLMProvider): boolean {
        return provider.provider_name === 'ollama' ||
               provider.endpoint.includes('localhost:11434') ||
               provider.endpoint.includes('127.0.0.1:11434');
    }

    /**
     * Ollama native /api/generate endpoint (streaming).
     *
     * Better for simple completions - returns response directly without
     * chat message wrapping.
     */
    private async *ollamaGenerateStream(
        channel: Channel,
        model: LLMModel,
        request: CompletionRequest,
    ): AsyncIterable<StreamChunk> {
        const body: OllamaGenerateRequest = {
            model: model.model_id,
            prompt: request.prompt,
            system: request.system,
            stream: true,
            options: {
                temperature: request.temperature,
                num_predict: request.max_tokens,
                stop: request.stop,
            },
        };

        const responses = channel.handle({
            op: 'request',
            data: {
                method: 'POST',
                path: '/api/generate',
                headers: { 'Content-Type': 'application/json' },
                body,
                accept: 'application/jsonl',
            },
        });

        for await (const response of responses) {
            if (response.op === 'item') {
                const data = response.data as OllamaGenerateResponse;

                yield {
                    text: data.response,
                    done: data.done,
                    finish_reason: data.done ? 'stop' : undefined,
                };
            }
            else if (response.op === 'error') {
                const err = response.data as { code?: string; message?: string };

                throw new Error(`Ollama API error: ${err.code} - ${err.message}`);
            }
            else if (response.op === 'done') {
                return;
            }
        }
    }

    /**
     * Ollama native /api/embeddings endpoint.
     */
    private async ollamaEmbed(
        channel: Channel,
        model: LLMModel,
        request: EmbeddingRequest,
    ): Promise<EmbeddingResponse> {
        // Ollama only supports single string input
        const inputs = Array.isArray(request.input) ? request.input : [request.input];
        const embeddings: number[][] = [];

        for (const input of inputs) {
            const body: OllamaEmbeddingRequest = {
                model: model.model_id,
                prompt: input,
            };

            const responses = channel.handle({
                op: 'request',
                data: {
                    method: 'POST',
                    path: '/api/embeddings',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                },
            });

            for await (const response of responses) {
                if (response.op === 'ok') {
                    const data = response.data as OllamaEmbeddingResponse;

                    embeddings.push(data.embedding);
                }
                else if (response.op === 'error') {
                    const err = response.data as { code?: string; message?: string };

                    throw new Error(`Ollama API error: ${err.code} - ${err.message}`);
                }
            }
        }

        return {
            embeddings,
            model: model.model_id,
        };
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Build chat messages from a simple prompt.
     */
    private buildMessagesFromPrompt(prompt: string, system?: string): ChatMessage[] {
        const messages: ChatMessage[] = [];

        if (system) {
            messages.push({ role: 'system', content: system });
        }

        messages.push({ role: 'user', content: prompt });

        return messages;
    }

    /**
     * Build OpenAI chat completion request body.
     */
    private buildChatRequest(
        model: LLMModel,
        request: ChatRequest,
        stream: boolean,
    ): OpenAIChatRequest {
        const messages: OpenAIMessage[] = request.messages.map(m => ({
            role: m.role,
            content: m.content,
        }));

        return {
            model: model.model_id,
            messages,
            temperature: request.temperature,
            max_tokens: request.max_tokens ?? model.max_output,
            stop: request.stop,
            stream,
        };
    }

    /**
     * Parse non-streaming completion response.
     */
    private parseCompletionResponse(
        data: OpenAIChatResponse,
        model: LLMModel,
    ): CompletionResponse {
        const choice = data.choices[0];

        let text = choice?.message?.content ?? '';

        // Apply strip_markdown if configured
        if (model.strip_markdown) {
            text = this.stripMarkdown(text);
        }

        return {
            text,
            model: data.model,
            usage: data.usage,
            finish_reason: (choice?.finish_reason as 'stop' | 'length' | 'tool_calls') ?? 'stop',
        };
    }

    /**
     * Parse streaming event into StreamChunk.
     */
    private parseStreamEvent(response: Response): StreamChunk | null {
        const event = response.data as { type?: string; data?: unknown };

        // Check for [DONE] marker
        if (event.data === '[DONE]') {
            return { text: '', done: true, finish_reason: 'stop' };
        }

        const chunk = event.data as OpenAIStreamChunk | undefined;

        if (!chunk?.choices?.[0]) {
            return null;
        }

        const choice = chunk.choices[0];
        const text = choice.delta?.content ?? '';
        const done = choice.finish_reason !== null;

        return {
            text,
            done,
            finish_reason: done ? (choice.finish_reason as 'stop' | 'length' | 'tool_calls') : undefined,
        };
    }

    /**
     * Strip markdown code fences from text.
     */
    private stripMarkdown(text: string): string {
        // Remove code fences: ```lang\n...\n```
        return text.replace(/```[\w]*\n?([\s\S]*?)\n?```/g, '$1').trim();
    }
}
