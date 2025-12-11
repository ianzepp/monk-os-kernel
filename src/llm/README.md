# LLM Module

The Language Model subsystem provides stateless LLM inference for Monk OS. Provider and model configuration is stored in EMS, with adapters translating between unified request/response types and provider-specific wire formats.

## Philosophy

- Stateless: No conversation memory, just prompt in → tokens out
- Config-driven: Adding providers/models is a database insert, not a code change
- Adapter pattern: Two adapters (OpenAI, Anthropic) cover all supported providers
- HAL channels: HTTP transport abstracted through HAL channel interface

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Syscall Layer (llm:complete, llm:chat, llm:embed)          │
├─────────────────────────────────────────────────────────────┤
│  LLM Class (model resolution, adapter dispatch)             │
├─────────────────────────────────────────────────────────────┤
│  Adapters (OpenAI, Anthropic)                               │
├─────────────────────────────────────────────────────────────┤
│  HAL Channel (HTTP transport with auth)                     │
├─────────────────────────────────────────────────────────────┤
│  Provider APIs (OpenAI, Ollama, Anthropic, etc.)            │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/llm/
├── index.ts              # Public exports
├── llm.ts                # LLM class (model resolution, inference)
├── types.ts              # Type definitions
└── adapters/
    ├── index.ts          # Adapter registry
    ├── types.ts          # Adapter interface
    ├── openai.ts         # OpenAI-compatible adapter
    └── anthropic.ts      # Anthropic Messages API adapter
```

## Core Concepts

### Providers

Provider configuration defines how to connect to an LLM service. A single provider can host multiple models.

**Provider Fields:**
```typescript
interface LLMProvider {
    provider_name: string;      // e.g., 'ollama', 'openai', 'anthropic'
    api_format: ApiFormat;      // 'openai' | 'anthropic'
    auth_type: AuthType;        // 'none' | 'bearer' | 'x-api-key'
    auth_value?: string;        // API key (supports env: prefix)
    endpoint: string;           // Base URL for API calls
    streaming_format: string;   // 'ndjson' | 'sse'
    status: ProviderStatus;     // 'active' | 'disabled'
}
```

**Supported Providers:**
| Provider | api_format | auth_type | endpoint |
|----------|------------|-----------|----------|
| Ollama | openai | none | http://localhost:11434 |
| OpenAI | openai | bearer | https://api.openai.com |
| Anthropic | anthropic | x-api-key | https://api.anthropic.com |
| Together AI | openai | bearer | https://api.together.xyz |
| Groq | openai | bearer | https://api.groq.com |

### Models

Model configuration defines capabilities and operational limits for a specific model.

**Model Fields:**
```typescript
interface LLMModel {
    model_name: string;           // Lookup key (e.g., 'qwen2.5-coder:1.5b')
    provider: string;             // FK to provider
    model_id: string;             // Provider-specific identifier
    supports_chat: boolean;       // Chat completions
    supports_completion: boolean; // Text completions
    supports_streaming: boolean;  // SSE/NDJSON streaming
    supports_embeddings: boolean; // Vector embeddings
    supports_vision: boolean;     // Image inputs
    supports_tools: boolean;      // Function calling
    context_window: number;       // Max input tokens
    max_output: number;           // Max output tokens
    strip_markdown: boolean;      // Remove code fences
    system_prompt_style: string;  // 'message' | 'prefix'
    status: ModelStatus;          // 'active' | 'disabled'
}
```

### Adapters

Adapters translate between unified request/response types and provider-specific wire formats.

**Adapter Responsibilities:**
- Build provider-specific request body
- Parse streaming responses into StreamChunk format
- Handle provider-specific error formats
- Apply model-specific transformations (strip_markdown, system_prompt_style)

**Adapter Interface:**
```typescript
interface Adapter {
    complete(channel, provider, model, request): Promise<CompletionResponse>;
    completeStream(channel, provider, model, request): AsyncIterable<StreamChunk>;
    chat(channel, provider, model, request): Promise<CompletionResponse>;
    chatStream(channel, provider, model, request): AsyncIterable<StreamChunk>;
    embed(channel, provider, model, request): Promise<EmbeddingResponse>;
}
```

**OpenAI Adapter:**
- Endpoint: `/v1/chat/completions`, `/v1/embeddings`
- Streaming: SSE with `data: [DONE]` terminator
- Ollama: Falls back to `/api/generate` and `/api/embeddings` for native format

**Anthropic Adapter:**
- Endpoint: `/v1/messages`
- Streaming: SSE with typed events (content_block_delta, message_delta)
- System prompt: Separate field, not in messages array
- Content blocks: `[{ type: 'text', text: '...' }]` instead of raw strings
- No embeddings support

## Usage

### Initialization

```typescript
import { LLM } from '@src/llm/index.js';

const llm = new LLM(hal, ems);
await llm.init();  // Loads schema from schema.sql
```

### List Available Models

```typescript
for await (const model of llm.listModels()) {
    console.log(model.model_name, model.context_window);
}

// Filter by capability
for await (const model of llm.listModels({ supports_chat: true })) {
    console.log(model.model_name);
}
```

### Text Completion

```typescript
// Non-streaming
const response = await llm.complete({
    model: 'qwen2.5-coder:1.5b',
    prompt: 'Write a haiku about programming',
    temperature: 0.7,
});
console.log(response.text);

// Streaming
for await (const chunk of llm.completeStream({
    model: 'qwen2.5-coder:1.5b',
    prompt: 'Explain recursion',
})) {
    process.stdout.write(chunk.text);
}
```

### Chat Completion

```typescript
// Non-streaming
const response = await llm.chat({
    model: 'claude-3.5-sonnet',
    messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France?' },
    ],
    temperature: 0.0,
});
console.log(response.text);

// Streaming
for await (const chunk of llm.chatStream({
    model: 'claude-3.5-sonnet',
    messages: [
        { role: 'user', content: 'Count to 10' },
    ],
})) {
    process.stdout.write(chunk.text);
}
```

### Embeddings

```typescript
const response = await llm.embed({
    model: 'mxbai-embed-large',
    input: ['Hello world', 'Goodbye world'],
});

console.log(response.embeddings.length);  // 2
console.log(response.embeddings[0].length);  // 1024 (depends on model)
```

## Configuration

### Provider Configuration

Providers are stored in the `llm_provider` table. Add providers via EMS:

```typescript
await ems.ops.insert('llm.provider', {
    provider_name: 'ollama',
    api_format: 'openai',
    auth_type: 'none',
    endpoint: 'http://localhost:11434',
    streaming_format: 'ndjson',
    status: 'active',
});
```

**Environment Variable Auth:**

Use `env:` prefix to read API keys from environment:

```typescript
await ems.ops.insert('llm.provider', {
    provider_name: 'openai',
    api_format: 'openai',
    auth_type: 'bearer',
    auth_value: 'env:OPENAI_API_KEY',  // Reads from process.env
    endpoint: 'https://api.openai.com',
    streaming_format: 'sse',
    status: 'active',
});
```

### Model Configuration

Models are stored in the `llm_model` table:

```typescript
await ems.ops.insert('llm.model', {
    model_name: 'qwen2.5-coder:1.5b',
    provider: 'ollama',
    model_id: 'qwen2.5-coder:1.5b',
    supports_chat: true,
    supports_completion: true,
    supports_streaming: true,
    supports_embeddings: false,
    supports_vision: false,
    supports_tools: false,
    context_window: 32768,
    max_output: 8192,
    strip_markdown: false,
    system_prompt_style: 'message',
    status: 'active',
});
```

## Request Types

### CompletionRequest

```typescript
interface CompletionRequest {
    model: string;         // Model name (must exist in llm_model)
    prompt: string;        // Text to complete
    system?: string;       // Optional system prompt
    temperature?: number;  // 0.0 = deterministic, 1.0+ = creative
    max_tokens?: number;   // Max tokens to generate
    stop?: string[];       // Stop sequences
    stream?: boolean;      // Enable streaming (use completeStream instead)
}
```

### ChatRequest

```typescript
interface ChatRequest {
    model: string;
    messages: ChatMessage[];  // [{ role, content }, ...]
    temperature?: number;
    max_tokens?: number;
    stop?: string[];
    stream?: boolean;
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
```

### EmbeddingRequest

```typescript
interface EmbeddingRequest {
    model: string;
    input: string | string[];  // Single text or batch
}
```

## Response Types

### CompletionResponse

```typescript
interface CompletionResponse {
    text: string;
    model: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    finish_reason?: 'stop' | 'length' | 'tool_calls';
}
```

### StreamChunk

```typescript
interface StreamChunk {
    text: string;              // Partial text content
    done: boolean;             // Whether this is the final chunk
    finish_reason?: string;    // Only on final chunk
}
```

### EmbeddingResponse

```typescript
interface EmbeddingResponse {
    embeddings: number[][];    // One vector per input
    model: string;
    usage?: {
        prompt_tokens: number;
        total_tokens: number;
    };
}
```

## Lifecycle

```typescript
const llm = new LLM(hal, ems);
await llm.init();      // Load schema, create tables, seed defaults

// ... use llm ...

await llm.shutdown();  // Currently a no-op (stateless, no connections)
```

Both `init()` and `shutdown()` are idempotent.

## Error Handling

**Model Not Found:**
```typescript
// Throws: Model not found: unknown-model
await llm.complete({ model: 'unknown-model', prompt: '...' });
```

**Model Disabled:**
```typescript
// Throws: Model disabled: disabled-model
await llm.complete({ model: 'disabled-model', prompt: '...' });
```

**Provider API Error:**
```typescript
// Throws: OpenAI API error: invalid_api_key - Incorrect API key
await llm.complete({ model: 'gpt-4', prompt: '...' });
```

**Unsupported Feature:**
```typescript
// Throws: Model qwen2.5-coder:1.5b does not support embeddings
await llm.embed({ model: 'qwen2.5-coder:1.5b', input: 'text' });
```

## Invariants

1. Schema loaded exactly once via `init()`
2. Model lookup fails fast if model not found or disabled
3. Provider auth applied per-request (no cached connections)
4. Adapters are stateless singletons (no per-request instances)
5. Channels closed after each request (no connection pooling)

## Public Exports

**Classes:**
- `LLM`
- `OpenAIAdapter`
- `AnthropicAdapter`

**Types:**
- `LLMProvider`, `LLMModel`, `ResolvedModel`
- `CompletionRequest`, `CompletionResponse`
- `ChatRequest`, `ChatMessage`
- `EmbeddingRequest`, `EmbeddingResponse`
- `StreamChunk`
- `ApiFormat`, `AuthType`, `StreamingFormat`
- `ProviderStatus`, `ModelStatus`, `SystemPromptStyle`
- `Adapter` (interface)
