/**
 * LLM Adapter Types
 *
 * Defines the interface for provider-specific adapters. Each adapter handles
 * request/response format translation for a specific wire protocol.
 *
 * ADAPTER RESPONSIBILITY
 * ======================
 * 1. Build provider-specific request body from our CompletionRequest/ChatRequest
 * 2. Send request via the provided Channel
 * 3. Parse streaming responses into our StreamChunk format
 * 4. Handle provider-specific error formats
 *
 * WHAT ADAPTERS DON'T DO
 * ======================
 * - Authentication (handled by LLM class via channel headers)
 * - Connection management (channel is passed in, closed by caller)
 * - Model resolution (LLM class resolves before calling adapter)
 *
 * @module llm/adapters/types
 */

import type { Channel } from '@src/hal/channel/types.js';
import type {
    LLMProvider,
    LLMModel,
    CompletionRequest,
    CompletionResponse,
    ChatRequest,
    EmbeddingRequest,
    EmbeddingResponse,
    StreamChunk,
} from '../types.js';

// =============================================================================
// ADAPTER INTERFACE
// =============================================================================

/**
 * LLM provider adapter.
 *
 * Translates between our request/response types and provider-specific formats.
 * Each adapter handles one api_format (e.g., 'openai', 'anthropic').
 */
export interface Adapter {
    /**
     * Adapter name (matches api_format in llm_provider).
     */
    readonly name: string;

    /**
     * Generate a completion (non-streaming).
     *
     * @param channel - HTTP channel to provider endpoint
     * @param provider - Provider configuration
     * @param model - Model configuration
     * @param request - Completion request
     * @returns Completion response
     */
    complete(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: CompletionRequest,
    ): Promise<CompletionResponse>;

    /**
     * Generate a streaming completion.
     *
     * @param channel - HTTP channel to provider endpoint
     * @param provider - Provider configuration
     * @param model - Model configuration
     * @param request - Completion request
     * @yields Stream chunks as they arrive
     */
    completeStream(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: CompletionRequest,
    ): AsyncIterable<StreamChunk>;

    /**
     * Chat completion (non-streaming).
     *
     * @param channel - HTTP channel to provider endpoint
     * @param provider - Provider configuration
     * @param model - Model configuration
     * @param request - Chat request with messages
     * @returns Completion response
     */
    chat(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: ChatRequest,
    ): Promise<CompletionResponse>;

    /**
     * Streaming chat completion.
     *
     * @param channel - HTTP channel to provider endpoint
     * @param provider - Provider configuration
     * @param model - Model configuration
     * @param request - Chat request with messages
     * @yields Stream chunks as they arrive
     */
    chatStream(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: ChatRequest,
    ): AsyncIterable<StreamChunk>;

    /**
     * Generate embeddings.
     *
     * @param channel - HTTP channel to provider endpoint
     * @param provider - Provider configuration
     * @param model - Model configuration
     * @param request - Embedding request
     * @returns Embedding response with vectors
     */
    embed(
        channel: Channel,
        provider: LLMProvider,
        model: LLMModel,
        request: EmbeddingRequest,
    ): Promise<EmbeddingResponse>;
}

// =============================================================================
// PROVIDER-SPECIFIC REQUEST/RESPONSE TYPES
// =============================================================================
// These are internal types used by adapters to communicate with providers.
// They're exported for testing but shouldn't be used outside adapters.

/**
 * OpenAI-format chat message.
 */
export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * OpenAI-format chat completion request.
 */
export interface OpenAIChatRequest {
    model: string;
    messages: OpenAIMessage[];
    temperature?: number;
    max_tokens?: number;
    stop?: string[];
    stream?: boolean;
}

/**
 * OpenAI-format completion response (non-streaming).
 */
export interface OpenAIChatResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

/**
 * OpenAI-format streaming chunk.
 */
export interface OpenAIStreamChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
        };
        finish_reason: string | null;
    }>;
}

/**
 * OpenAI-format embedding request.
 */
export interface OpenAIEmbeddingRequest {
    model: string;
    input: string | string[];
}

/**
 * OpenAI-format embedding response.
 */
export interface OpenAIEmbeddingResponse {
    object: string;
    data: Array<{
        object: string;
        index: number;
        embedding: number[];
    }>;
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

/**
 * Ollama-format generate request (used for completions).
 */
export interface OllamaGenerateRequest {
    model: string;
    prompt: string;
    system?: string;
    stream?: boolean;
    options?: {
        temperature?: number;
        num_predict?: number;
        stop?: string[];
    };
}

/**
 * Ollama-format generate response (streaming chunk).
 */
export interface OllamaGenerateResponse {
    model: string;
    created_at: string;
    response: string;
    done: boolean;
    context?: number[];
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
}

/**
 * Ollama-format embedding request.
 */
export interface OllamaEmbeddingRequest {
    model: string;
    prompt: string;
}

/**
 * Ollama-format embedding response.
 */
export interface OllamaEmbeddingResponse {
    embedding: number[];
}
