/**
 * LLM Types - Type definitions for the LLM subsystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * These types define the configuration and request/response interfaces for
 * the LLM subsystem. Provider and model configuration is stored in EMS,
 * but these interfaces provide type safety for TypeScript consumers.
 *
 * NAMING CONVENTIONS
 * ==================
 * - Model name: 'llm.provider', 'llm.model' (EMS model identifier)
 * - Table name: 'llm_provider', 'llm_model' (SQL table, underscore convention)
 * - Interface: LLMProvider, LLMModel (TypeScript, PascalCase)
 *
 * @module llm/types
 */

// =============================================================================
// PROVIDER CONFIGURATION
// =============================================================================

/**
 * Wire protocol format for LLM API calls.
 *
 * WHY only two: Most LLM providers speak one of these formats.
 * - 'openai': OpenAI-compatible (OpenAI, Ollama, Together, Groq, vLLM)
 * - 'anthropic': Anthropic-specific format
 */
export type ApiFormat = 'openai' | 'anthropic';

/**
 * Authentication method for provider API calls.
 *
 * - 'none': No authentication (local Ollama)
 * - 'bearer': Authorization: Bearer <token> (OpenAI)
 * - 'x-api-key': x-api-key: <key> (Anthropic)
 */
export type AuthType = 'none' | 'bearer' | 'x-api-key';

/**
 * Streaming response format.
 *
 * - 'ndjson': Newline-delimited JSON (Ollama native)
 * - 'sse': Server-Sent Events (OpenAI, Anthropic)
 */
export type StreamingFormat = 'ndjson' | 'sse';

/**
 * Provider status for enable/disable without deletion.
 */
export type ProviderStatus = 'active' | 'disabled';

/**
 * LLM provider configuration.
 *
 * Defines how to connect to an LLM service. A provider can host multiple models.
 */
export interface LLMProvider {
    /** Unique provider identifier (PK) */
    id: string;

    /** Human-readable provider name (e.g., 'ollama', 'openai', 'anthropic') */
    provider_name: string;

    /** Wire protocol format */
    api_format: ApiFormat;

    /** Authentication method */
    auth_type: AuthType;

    /** API key or token (null if auth_type='none') */
    auth_value?: string | null;

    /** Base URL for API calls */
    endpoint: string;

    /** Streaming response format */
    streaming_format: StreamingFormat;

    /** Provider status */
    status: ProviderStatus;

    /** Timestamps */
    created_at?: string;
    updated_at?: string;
    trashed_at?: string | null;
}

// =============================================================================
// MODEL CONFIGURATION
// =============================================================================

/**
 * How to send system prompts to the model.
 *
 * - 'message': Separate system message in messages array (modern models)
 * - 'prefix': Prepend to first user message (older models)
 */
export type SystemPromptStyle = 'message' | 'prefix';

/**
 * Model status for enable/disable without deletion.
 */
export type ModelStatus = 'active' | 'disabled';

/**
 * LLM model configuration.
 *
 * Defines what a specific model can do and its operational limits.
 */
export interface LLMModel {
    /** Unique model identifier (PK) */
    id: string;

    /** Model name for syscall lookups (e.g., 'qwen2.5-coder:1.5b') */
    model_name: string;

    /** Provider hosting this model (FK to llm_provider.provider_name) */
    provider: string;

    /** Provider-specific model identifier sent in API requests */
    model_id: string;

    /** Capability flags */
    supports_chat: boolean;
    supports_completion: boolean;
    supports_streaming: boolean;
    supports_embeddings: boolean;
    supports_vision: boolean;
    supports_tools: boolean;

    /** Maximum input tokens (context window size) */
    context_window: number;

    /** Maximum output tokens per request */
    max_output: number;

    /** Post-processing: strip markdown code fences from output */
    strip_markdown: boolean;

    /** How to send system prompts */
    system_prompt_style: SystemPromptStyle;

    /** Model status */
    status: ModelStatus;

    /** Timestamps */
    created_at?: string;
    updated_at?: string;
    trashed_at?: string | null;
}

// =============================================================================
// REQUEST/RESPONSE TYPES
// =============================================================================

/**
 * Chat message role.
 */
export type MessageRole = 'system' | 'user' | 'assistant';

/**
 * Chat message in conversation.
 */
export interface ChatMessage {
    role: MessageRole;
    content: string;
}

/**
 * Completion request options.
 *
 * Used for llm:complete syscall.
 */
export interface CompletionRequest {
    /** Model name (must exist in llm_model table) */
    model: string;

    /** Prompt text for completion */
    prompt: string;

    /** Optional system prompt */
    system?: string;

    /** Temperature (0.0 = deterministic, 1.0+ = creative) */
    temperature?: number;

    /** Maximum tokens to generate */
    max_tokens?: number;

    /** Stop sequences */
    stop?: string[];

    /** Enable streaming response */
    stream?: boolean;
}

/**
 * Chat request options.
 *
 * Used for llm:chat syscall.
 */
export interface ChatRequest {
    /** Model name (must exist in llm_model table) */
    model: string;

    /** Conversation messages */
    messages: ChatMessage[];

    /** Temperature (0.0 = deterministic, 1.0+ = creative) */
    temperature?: number;

    /** Maximum tokens to generate */
    max_tokens?: number;

    /** Stop sequences */
    stop?: string[];

    /** Enable streaming response */
    stream?: boolean;
}

/**
 * Embedding request options.
 *
 * Used for llm:embed syscall.
 */
export interface EmbeddingRequest {
    /** Model name (must support embeddings) */
    model: string;

    /** Text to embed (single string or array) */
    input: string | string[];
}

/**
 * Completion response.
 */
export interface CompletionResponse {
    /** Generated text */
    text: string;

    /** Model that generated the response */
    model: string;

    /** Token usage statistics */
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };

    /** Finish reason */
    finish_reason?: 'stop' | 'length' | 'tool_calls';
}

/**
 * Streaming chunk for completion/chat.
 */
export interface StreamChunk {
    /** Partial text content */
    text: string;

    /** Whether this is the final chunk */
    done: boolean;

    /** Finish reason (only on final chunk) */
    finish_reason?: 'stop' | 'length' | 'tool_calls';
}

/**
 * Embedding response.
 */
export interface EmbeddingResponse {
    /** Embedding vectors (one per input) */
    embeddings: number[][];

    /** Model that generated embeddings */
    model: string;

    /** Token usage */
    usage?: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/**
 * Resolved model configuration with provider details.
 *
 * Used internally after joining model + provider tables.
 */
export interface ResolvedModel {
    /** Model configuration */
    model: LLMModel;

    /** Provider configuration */
    provider: LLMProvider;
}
