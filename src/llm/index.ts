/**
 * LLM Module - Language Model Subsystem
 *
 * Provides stateless LLM inference for Monk OS. Configuration lives in EMS,
 * actual HTTP transport uses HAL channels.
 *
 * USAGE
 * =====
 * ```typescript
 * import { LLM } from '@src/llm/index.js';
 *
 * const llm = new LLM(hal, ems);
 * await llm.init();
 *
 * // List available models
 * for await (const model of llm.listModels()) {
 *     console.log(model.model_name, model.context_window);
 * }
 *
 * // Generate a completion
 * const response = await llm.complete({
 *     model: 'qwen2.5-coder:1.5b',
 *     prompt: 'Write a haiku about programming',
 * });
 *
 * // Stream a completion
 * for await (const chunk of llm.completeStream({
 *     model: 'qwen2.5-coder:1.5b',
 *     prompt: 'Explain recursion',
 * })) {
 *     process.stdout.write(chunk.text);
 * }
 * ```
 *
 * @module llm
 */

// =============================================================================
// CLASS EXPORTS
// =============================================================================

export { LLM } from './llm.js';

// =============================================================================
// ADAPTER EXPORTS
// =============================================================================

export { getAdapter, OpenAIAdapter, AnthropicAdapter } from './adapters/index.js';
export type { Adapter } from './adapters/index.js';

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type {
    // Provider types
    ApiFormat,
    AuthType,
    StreamingFormat,
    ProviderStatus,
    LLMProvider,

    // Model types
    SystemPromptStyle,
    ModelStatus,
    LLMModel,

    // Request/response types
    MessageRole,
    ChatMessage,
    CompletionRequest,
    CompletionResponse,
    ChatRequest,
    EmbeddingRequest,
    EmbeddingResponse,
    StreamChunk,

    // Internal types
    ResolvedModel,
} from './types.js';
