/**
 * LLM - Language Model Subsystem
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The LLM subsystem is a kernel service that provides stateless inference.
 * It reads provider/model configuration from EMS and dispatches requests
 * to provider-specific adapters.
 *
 * KEY DESIGN DECISIONS
 * ====================
 * - Stateless: No memory, no context, just prompt in → tokens out
 * - Config in EMS: Adding providers/models is database insert, not code change
 * - Two adapters: OpenAI-format (most providers) and Anthropic-format
 * - HAL channels: Uses hal.channel for HTTP transport
 *
 * INVARIANTS
 * ==========
 * INV-1: Schema loaded exactly once via init()
 * INV-2: Model lookup fails fast if model not found or disabled
 * INV-3: Provider auth is applied per-request (no cached connections)
 *
 * @module llm
 */

import type { HAL } from '@src/hal/index.js';
import type { EMS } from '@src/ems/ems.js';
import type { WhereConditions } from '@src/ems/index.js';
import type { Channel } from '@src/hal/channel/types.js';
import { getAdapter } from './adapters/index.js';
import type {
    LLMProvider,
    LLMModel,
    ResolvedModel,
    CompletionRequest,
    CompletionResponse,
    ChatRequest,
    EmbeddingRequest,
    EmbeddingResponse,
    StreamChunk,
} from './types.js';

// =============================================================================
// LLM CLASS
// =============================================================================

/**
 * LLM subsystem.
 *
 * Provides stateless inference capabilities via llm:complete, llm:chat,
 * and llm:embed syscalls. Configuration lives in EMS tables.
 */
export class LLM {
    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    /**
     * Hardware Abstraction Layer.
     *
     * Used for:
     * - file: Read schema.sql during init
     * - channel: HTTP requests to LLM providers
     */
    private readonly hal: HAL;

    /**
     * Entity Management System.
     *
     * Used for:
     * - exec(): Load schema during init
     * - ops: Query provider/model configuration
     */
    private readonly ems: EMS;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Initialization flag.
     *
     * WHY: init() creates tables and seeds. Must be idempotent.
     */
    private initialized = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create LLM subsystem.
     *
     * NOTE: Does NOT initialize. Call init() after construction.
     *
     * @param hal - Hardware abstraction layer
     * @param ems - Entity management system
     */
    constructor(hal: HAL, ems: EMS) {
        this.hal = hal;
        this.ems = ems;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize LLM subsystem.
     *
     * Loads schema from schema.sql, creating tables and seeding default
     * providers/models. Idempotent - safe to call multiple times.
     *
     * @throws Error if schema cannot be loaded
     */
    async init(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;

        // Load and apply LLM schema
        const schemaPath = new URL('./schema.sql', import.meta.url).pathname;
        const schema = await this.hal.file.readText(schemaPath);

        await this.ems.exec(schema, { clearModels: true });
    }

    /**
     * Shutdown LLM subsystem.
     *
     * Currently a no-op since LLM is stateless (no connections to close).
     * Included for lifecycle symmetry with other subsystems.
     */
    async shutdown(): Promise<void> {
        this.initialized = false;
    }

    // =========================================================================
    // MODEL RESOLUTION
    // =========================================================================

    /**
     * Resolve a model name to full configuration.
     *
     * Joins llm_model with llm_provider to get complete config needed
     * for API calls.
     *
     * @param modelName - Model name (e.g., 'qwen2.5-coder:1.5b')
     * @returns Resolved model with provider details
     * @throws Error if model not found or disabled
     */
    async resolveModel(modelName: string): Promise<ResolvedModel> {
        // Query model
        let model: LLMModel | null = null;

        for await (const row of this.ems.ops.selectAny('llm.model', {
            where: { model_name: modelName },
            limit: 1,
        })) {
            model = this.rowToModel(row as Record<string, unknown>);
        }

        if (!model) {
            throw new Error(`Model not found: ${modelName}`);
        }

        if (model.status !== 'active') {
            throw new Error(`Model disabled: ${modelName}`);
        }

        // Query provider
        let provider: LLMProvider | null = null;

        for await (const row of this.ems.ops.selectAny('llm.provider', {
            where: { provider_name: model.provider },
            limit: 1,
        })) {
            provider = this.rowToProvider(row as Record<string, unknown>);
        }

        if (!provider) {
            throw new Error(`Provider not found: ${model.provider}`);
        }

        if (provider.status !== 'active') {
            throw new Error(`Provider disabled: ${model.provider}`);
        }

        return { model, provider };
    }

    /**
     * List available models.
     *
     * @param filter - Optional filter (e.g., { supports_chat: 1 })
     * @returns Async iterable of models
     */
    async *listModels(filter?: WhereConditions): AsyncIterable<LLMModel> {
        const where: WhereConditions = { status: 'active', ...filter };

        for await (const row of this.ems.ops.selectAny('llm.model', { where })) {
            yield this.rowToModel(row as Record<string, unknown>);
        }
    }

    /**
     * List available providers.
     *
     * @returns Async iterable of providers
     */
    async *listProviders(): AsyncIterable<LLMProvider> {
        for await (const row of this.ems.ops.selectAny('llm.provider', {
            where: { status: 'active' },
        })) {
            yield this.rowToProvider(row as Record<string, unknown>);
        }
    }

    // =========================================================================
    // INFERENCE OPERATIONS
    // =========================================================================

    /**
     * Generate a completion (non-streaming).
     *
     * @param request - Completion request
     * @returns Completion response
     */
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const { model, provider } = await this.resolveModel(request.model);
        const adapter = getAdapter(provider.api_format);
        const channel = await this.openChannel(provider);

        try {
            return await adapter.complete(channel, provider, model, request);
        }
        finally {
            await channel.close();
        }
    }

    /**
     * Generate a streaming completion.
     *
     * @param request - Completion request
     * @yields Streaming chunks
     */
    async *completeStream(request: CompletionRequest): AsyncIterable<StreamChunk> {
        const { model, provider } = await this.resolveModel(request.model);
        const adapter = getAdapter(provider.api_format);
        const channel = await this.openChannel(provider);

        try {
            yield* adapter.completeStream(channel, provider, model, request);
        }
        finally {
            await channel.close();
        }
    }

    /**
     * Chat completion (non-streaming).
     *
     * @param request - Chat request
     * @returns Completion response
     */
    async chat(request: ChatRequest): Promise<CompletionResponse> {
        const { model, provider } = await this.resolveModel(request.model);
        const adapter = getAdapter(provider.api_format);
        const channel = await this.openChannel(provider);

        try {
            return await adapter.chat(channel, provider, model, request);
        }
        finally {
            await channel.close();
        }
    }

    /**
     * Streaming chat completion.
     *
     * @param request - Chat request
     * @yields Streaming chunks
     */
    async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
        const { model, provider } = await this.resolveModel(request.model);
        const adapter = getAdapter(provider.api_format);
        const channel = await this.openChannel(provider);

        try {
            yield* adapter.chatStream(channel, provider, model, request);
        }
        finally {
            await channel.close();
        }
    }

    /**
     * Generate embeddings.
     *
     * @param request - Embedding request
     * @returns Embedding response
     */
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
        const { model, provider } = await this.resolveModel(request.model);

        if (!model.supports_embeddings) {
            throw new Error(`Model ${request.model} does not support embeddings`);
        }

        const adapter = getAdapter(provider.api_format);
        const channel = await this.openChannel(provider);

        try {
            return await adapter.embed(channel, provider, model, request);
        }
        finally {
            await channel.close();
        }
    }

    // =========================================================================
    // CHANNEL MANAGEMENT
    // =========================================================================

    /**
     * Open a channel to the provider with appropriate auth headers.
     */
    private async openChannel(provider: LLMProvider): Promise<Channel> {
        const headers = this.buildAuthHeaders(provider);

        return this.hal.channel.open('http', provider.endpoint, {
            headers,
            timeout: 120000, // 2 minute timeout for LLM requests
        });
    }

    /**
     * Build authentication headers for a provider.
     */
    private buildAuthHeaders(provider: LLMProvider): Record<string, string> {
        const headers: Record<string, string> = {};

        switch (provider.auth_type) {
            case 'bearer':
                if (provider.auth_value) {
                    headers['Authorization'] = `Bearer ${provider.auth_value}`;
                }
                break;

            case 'x-api-key':
                if (provider.auth_value) {
                    headers['x-api-key'] = provider.auth_value;
                }
                break;

            case 'none':
            default:
                // No auth headers needed
                break;
        }

        return headers;
    }

    // =========================================================================
    // ROW MAPPING
    // =========================================================================

    /**
     * Map database row to LLMModel interface.
     */
    private rowToModel(row: Record<string, unknown>): LLMModel {
        return {
            id: row.id as string,
            model_name: row.model_name as string,
            provider: row.provider as string,
            model_id: row.model_id as string,
            supports_chat: Boolean(row.supports_chat),
            supports_completion: Boolean(row.supports_completion),
            supports_streaming: Boolean(row.supports_streaming),
            supports_embeddings: Boolean(row.supports_embeddings),
            supports_vision: Boolean(row.supports_vision),
            supports_tools: Boolean(row.supports_tools),
            context_window: row.context_window as number,
            max_output: row.max_output as number,
            strip_markdown: Boolean(row.strip_markdown),
            system_prompt_style: (row.system_prompt_style as 'message' | 'prefix') ?? 'message',
            status: (row.status as 'active' | 'disabled') ?? 'active',
            created_at: row.created_at as string | undefined,
            updated_at: row.updated_at as string | undefined,
            trashed_at: row.trashed_at as string | null | undefined,
        };
    }

    /**
     * Map database row to LLMProvider interface.
     */
    private rowToProvider(row: Record<string, unknown>): LLMProvider {
        return {
            id: row.id as string,
            provider_name: row.provider_name as string,
            api_format: row.api_format as 'openai' | 'anthropic',
            auth_type: (row.auth_type as 'none' | 'bearer' | 'x-api-key') ?? 'none',
            auth_value: row.auth_value as string | null | undefined,
            endpoint: row.endpoint as string,
            streaming_format: (row.streaming_format as 'ndjson' | 'sse') ?? 'sse',
            status: (row.status as 'active' | 'disabled') ?? 'active',
            created_at: row.created_at as string | undefined,
            updated_at: row.updated_at as string | undefined,
            trashed_at: row.trashed_at as string | null | undefined,
        };
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Check if LLM is initialized.
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}
