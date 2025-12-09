-- =============================================================================
-- LLM SCHEMA
-- =============================================================================
--
-- Language Model subsystem tables and seed data.
-- Applied by LLM.init() after EMS core schema is loaded.
--
-- ARCHITECTURE OVERVIEW
-- =====================
-- The LLM subsystem provides a stateless inference pipe for AI agents.
-- Configuration lives in EMS (not flat config files), so adding new providers
-- or models is an EMS insert, not a code change.
--
-- DEPENDENCIES
-- ============
-- Requires EMS core schema (models, fields tables must exist).
--
-- TABLE HIERARCHY
-- ===============
-- llm_provider   Provider configuration (how to connect)
--     |
--     +-- llm_model   Model configuration (what it can do)

-- =============================================================================
-- SEED DATA: LLM SYSTEM MODELS
-- =============================================================================
-- Model definitions for provider and model configuration.

INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('llm.provider', 'system', 'LLM provider configuration - API endpoints and auth'),
    ('llm.model', 'system', 'LLM model configuration - capabilities and limits');

-- =============================================================================
-- LLM_PROVIDER TABLE
-- =============================================================================
-- Provider configuration: how to connect to an LLM service.
--
-- WHY separate from models: A provider can host multiple models.
-- Ollama hosts many models at one endpoint, OpenAI has GPT-4, GPT-3.5, etc.

CREATE TABLE IF NOT EXISTS llm_provider (
    -- Identity
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    trashed_at      TEXT,
    expired_at      TEXT,

    -- Provider identity
    -- WHY provider_name UNIQUE: Natural key for lookups in model config.
    provider_name   TEXT NOT NULL UNIQUE,

    -- API wire format
    -- WHY api_format: Most providers speak OpenAI or Anthropic format.
    -- 'openai' = OpenAI-compatible (Ollama, Together, Groq, local)
    -- 'anthropic' = Anthropic-specific format
    api_format      TEXT NOT NULL CHECK (api_format IN ('openai', 'anthropic')),

    -- Authentication
    -- WHY auth_type enum: Different providers use different auth patterns.
    -- 'none' = no auth (local Ollama)
    -- 'bearer' = Authorization: Bearer <token>
    -- 'x-api-key' = x-api-key: <key> (Anthropic)
    auth_type       TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'x-api-key')),

    -- WHY auth_value nullable: Only needed if auth_type != 'none'.
    -- Could reference a secrets store in production.
    auth_value      TEXT,

    -- API endpoint
    -- WHY endpoint required: Base URL for all API calls.
    -- Examples: 'http://localhost:11434', 'https://api.anthropic.com'
    endpoint        TEXT NOT NULL,

    -- Streaming format
    -- WHY streaming_format: Different protocols for streaming responses.
    -- 'ndjson' = newline-delimited JSON (Ollama)
    -- 'sse' = Server-Sent Events (OpenAI, Anthropic)
    streaming_format TEXT NOT NULL DEFAULT 'sse' CHECK (streaming_format IN ('ndjson', 'sse')),

    -- Provider status
    -- WHY status: Enable/disable providers without deleting config.
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

-- Index for active provider lookup
CREATE INDEX IF NOT EXISTS idx_llm_provider_status
    ON llm_provider(status)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- LLM_MODEL TABLE
-- =============================================================================
-- Model configuration: what a specific model can do.
--
-- WHY detailed capability flags: Caller doesn't need to know provider details.
-- Just ask for a model that supports_vision and let the subsystem find one.

CREATE TABLE IF NOT EXISTS llm_model (
    -- Identity
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    trashed_at      TEXT,
    expired_at      TEXT,

    -- Model identity
    -- WHY model_name UNIQUE: Natural key for syscall lookups.
    -- This is what callers pass to llm:complete.
    model_name      TEXT NOT NULL UNIQUE,

    -- Provider relationship
    -- WHY FK to provider_name: Enables readable config, join for endpoint.
    provider        TEXT NOT NULL REFERENCES llm_provider(provider_name) ON DELETE CASCADE,

    -- Provider-specific model identifier
    -- WHY model_id: What to send in the API request body.
    -- Examples: 'qwen2.5-coder:1.5b', 'claude-sonnet-4-20250514', 'gpt-4'
    model_id        TEXT NOT NULL,

    -- -------------------------------------------------------------------------
    -- Capability Flags
    -- -------------------------------------------------------------------------
    -- WHY boolean flags: Enables capability-based model selection.
    -- "Give me any model that supports vision" without knowing providers.

    supports_chat           INTEGER DEFAULT 1,
    supports_completion     INTEGER DEFAULT 1,
    supports_streaming      INTEGER DEFAULT 1,
    supports_embeddings     INTEGER DEFAULT 0,
    supports_vision         INTEGER DEFAULT 0,
    supports_tools          INTEGER DEFAULT 0,

    -- -------------------------------------------------------------------------
    -- Limits
    -- -------------------------------------------------------------------------
    -- WHY limits: Context management needs to know capacity.

    -- Maximum input tokens (context window size)
    context_window  INTEGER NOT NULL DEFAULT 4096,

    -- Maximum output tokens per request
    max_output      INTEGER NOT NULL DEFAULT 4096,

    -- -------------------------------------------------------------------------
    -- Behavioral Flags
    -- -------------------------------------------------------------------------
    -- WHY behavioral flags: Post-processing and format quirks.

    -- Strip markdown code fences from output (some models wrap everything)
    strip_markdown  INTEGER DEFAULT 0,

    -- How to send system prompts
    -- 'message' = separate system message (OpenAI, Anthropic)
    -- 'prefix' = prepend to first user message (older models)
    system_prompt_style TEXT DEFAULT 'message' CHECK (system_prompt_style IN ('message', 'prefix')),

    -- Model status
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

-- Index for finding models by provider
CREATE INDEX IF NOT EXISTS idx_llm_model_provider
    ON llm_model(provider)
    WHERE trashed_at IS NULL;

-- Index for finding active models
CREATE INDEX IF NOT EXISTS idx_llm_model_status
    ON llm_model(status)
    WHERE trashed_at IS NULL;

-- Index for capability-based queries
CREATE INDEX IF NOT EXISTS idx_llm_model_capabilities
    ON llm_model(supports_chat, supports_completion, supports_embeddings, supports_vision)
    WHERE trashed_at IS NULL AND status = 'active';

-- =============================================================================
-- SEED DATA: LLM_PROVIDER FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('llm.provider', 'provider_name', 'text', 1, 'Unique provider identifier'),
    ('llm.provider', 'api_format', 'text', 1, 'Wire protocol format: openai or anthropic'),
    ('llm.provider', 'auth_type', 'text', 1, 'Authentication method: none, bearer, x-api-key'),
    ('llm.provider', 'auth_value', 'text', 0, 'API key or token (null if auth_type=none)'),
    ('llm.provider', 'endpoint', 'text', 1, 'Base URL for API calls'),
    ('llm.provider', 'streaming_format', 'text', 1, 'Streaming protocol: ndjson or sse'),
    ('llm.provider', 'status', 'text', 1, 'Provider status: active or disabled');

-- =============================================================================
-- SEED DATA: LLM_MODEL FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (model_name, field_name, type, required, description) VALUES
    ('llm.model', 'model_name', 'text', 1, 'Unique model identifier for syscalls'),
    ('llm.model', 'provider', 'text', 1, 'Provider hosting this model'),
    ('llm.model', 'model_id', 'text', 1, 'Provider-specific model identifier'),
    ('llm.model', 'supports_chat', 'boolean', 0, 'Supports multi-turn chat'),
    ('llm.model', 'supports_completion', 'boolean', 0, 'Supports single-shot completion'),
    ('llm.model', 'supports_streaming', 'boolean', 0, 'Supports streaming responses'),
    ('llm.model', 'supports_embeddings', 'boolean', 0, 'Supports text embeddings'),
    ('llm.model', 'supports_vision', 'boolean', 0, 'Supports image input'),
    ('llm.model', 'supports_tools', 'boolean', 0, 'Supports tool/function calling'),
    ('llm.model', 'context_window', 'integer', 1, 'Maximum input tokens'),
    ('llm.model', 'max_output', 'integer', 1, 'Maximum output tokens'),
    ('llm.model', 'strip_markdown', 'boolean', 0, 'Strip markdown fences from output'),
    ('llm.model', 'system_prompt_style', 'text', 0, 'How to send system prompts: message or prefix'),
    ('llm.model', 'status', 'text', 1, 'Model status: active or disabled');

-- =============================================================================
-- SEED DATA: DEFAULT PROVIDERS
-- =============================================================================
-- Pre-configured providers for common setups.

INSERT OR IGNORE INTO llm_provider (provider_name, api_format, auth_type, endpoint, streaming_format, status) VALUES
    ('ollama', 'openai', 'none', 'http://localhost:11434', 'ndjson', 'active'),
    ('openai', 'openai', 'bearer', 'https://api.openai.com', 'sse', 'disabled'),
    ('anthropic', 'anthropic', 'x-api-key', 'https://api.anthropic.com', 'sse', 'disabled');

-- =============================================================================
-- SEED DATA: DEFAULT MODELS
-- =============================================================================
-- Pre-configured models. Ollama models active by default (local inference).

INSERT OR IGNORE INTO llm_model (
    model_name, provider, model_id,
    supports_chat, supports_completion, supports_streaming,
    supports_embeddings, supports_vision, supports_tools,
    context_window, max_output, strip_markdown, system_prompt_style, status
) VALUES
    -- Ollama models (local, active by default)
    ('qwen2.5-coder:1.5b', 'ollama', 'qwen2.5-coder:1.5b',
     1, 1, 1, 0, 0, 0, 32768, 8192, 0, 'message', 'active'),
    ('qwen2.5-coder:7b', 'ollama', 'qwen2.5-coder:7b',
     1, 1, 1, 0, 0, 0, 32768, 8192, 0, 'message', 'active'),
    ('llama3.2:3b', 'ollama', 'llama3.2:3b',
     1, 1, 1, 0, 0, 0, 131072, 8192, 0, 'message', 'active'),
    ('nomic-embed-text', 'ollama', 'nomic-embed-text',
     0, 0, 0, 1, 0, 0, 8192, 0, 0, 'message', 'active'),

    -- OpenAI models (disabled by default - needs API key)
    ('gpt-4o', 'openai', 'gpt-4o',
     1, 1, 1, 0, 1, 1, 128000, 16384, 0, 'message', 'disabled'),
    ('gpt-4o-mini', 'openai', 'gpt-4o-mini',
     1, 1, 1, 0, 1, 1, 128000, 16384, 0, 'message', 'disabled'),

    -- Anthropic models (disabled by default - needs API key)
    ('claude-sonnet-4', 'anthropic', 'claude-sonnet-4-20250514',
     1, 1, 1, 0, 1, 1, 200000, 8192, 0, 'message', 'disabled'),
    ('claude-haiku-3.5', 'anthropic', 'claude-3-5-haiku-20241022',
     1, 1, 1, 0, 1, 1, 200000, 8192, 0, 'message', 'disabled');
