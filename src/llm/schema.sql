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
-- Complete field definitions with constraints matching the table DDL.

INSERT OR IGNORE INTO fields (
    model_name, field_name, type, required, default_value, enum_values,
    unique_, index_, description
) VALUES
    ('llm.provider', 'provider_name', 'text', 1, NULL, NULL,
     1, 0, 'Unique provider identifier'),
    ('llm.provider', 'api_format', 'text', 1, NULL, '["openai","anthropic"]',
     0, 0, 'Wire protocol format: openai or anthropic'),
    ('llm.provider', 'auth_type', 'text', 1, 'none', '["none","bearer","x-api-key"]',
     0, 0, 'Authentication method: none, bearer, x-api-key'),
    ('llm.provider', 'auth_value', 'text', 0, NULL, NULL,
     0, 0, 'API key or token (null if auth_type=none)'),
    ('llm.provider', 'endpoint', 'text', 1, NULL, NULL,
     0, 0, 'Base URL for API calls'),
    ('llm.provider', 'streaming_format', 'text', 1, 'sse', '["ndjson","sse"]',
     0, 0, 'Streaming protocol: ndjson or sse'),
    ('llm.provider', 'status', 'text', 1, 'active', '["active","disabled"]',
     0, 1, 'Provider status: active or disabled');

-- =============================================================================
-- SEED DATA: LLM_MODEL FIELDS
-- =============================================================================
-- Complete field definitions with constraints, defaults, and relationships.

INSERT OR IGNORE INTO fields (
    model_name, field_name, type, required, default_value, enum_values,
    relationship_type, related_model, related_field, required_relationship,
    unique_, index_, description
) VALUES
    ('llm.model', 'model_name', 'text', 1, NULL, NULL,
     NULL, NULL, NULL, 0,
     1, 0, 'Unique model identifier for syscalls'),
    ('llm.model', 'provider', 'text', 1, NULL, NULL,
     'referenced', 'llm.provider', 'provider_name', 1,
     0, 1, 'Provider hosting this model'),
    ('llm.model', 'model_id', 'text', 1, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Provider-specific model identifier'),
    ('llm.model', 'supports_chat', 'boolean', 0, '1', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Supports multi-turn chat'),
    ('llm.model', 'supports_completion', 'boolean', 0, '1', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Supports single-shot completion'),
    ('llm.model', 'supports_streaming', 'boolean', 0, '1', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Supports streaming responses'),
    ('llm.model', 'supports_embeddings', 'boolean', 0, '0', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Supports text embeddings'),
    ('llm.model', 'supports_vision', 'boolean', 0, '0', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Supports image input'),
    ('llm.model', 'supports_tools', 'boolean', 0, '0', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Supports tool/function calling'),
    ('llm.model', 'context_window', 'integer', 1, '4096', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Maximum input tokens'),
    ('llm.model', 'max_output', 'integer', 1, '4096', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Maximum output tokens'),
    ('llm.model', 'strip_markdown', 'boolean', 0, '0', NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Strip markdown fences from output'),
    ('llm.model', 'system_prompt_style', 'text', 0, 'message', '["message","prefix"]',
     NULL, NULL, NULL, 0,
     0, 0, 'How to send system prompts: message or prefix'),
    ('llm.model', 'status', 'text', 1, 'active', '["active","disabled"]',
     NULL, NULL, NULL, 0,
     0, 1, 'Model status: active or disabled');

-- =============================================================================
-- SEED DATA: DEFAULT PROVIDERS
-- =============================================================================
-- Pre-configured providers for common setups.

INSERT OR IGNORE INTO llm_provider (provider_name, api_format, auth_type, auth_value, endpoint, streaming_format, status) VALUES
    ('ollama', 'openai', 'none', NULL, 'http://localhost:11434', 'ndjson', 'active'),
    ('openai', 'openai', 'bearer', 'env:OPENAI_API_KEY', 'https://api.openai.com', 'sse', 'disabled'),
    ('anthropic', 'anthropic', 'x-api-key', 'env:ANTHROPIC_API_KEY', 'https://api.anthropic.com', 'sse', 'active');

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

    -- Anthropic models (active - uses env:ANTHROPIC_API_KEY)
    ('claude-sonnet-4', 'anthropic', 'claude-sonnet-4-20250514',
     1, 1, 1, 0, 1, 1, 200000, 8192, 0, 'message', 'active'),
    ('claude-haiku-3.5', 'anthropic', 'claude-3-5-haiku-20241022',
     1, 1, 1, 0, 1, 1, 200000, 8192, 0, 'message', 'active');

-- =============================================================================
-- AI_TASK TABLE
-- =============================================================================
-- Task queue for AI agents. Inspired by Oxygen Not Included's priority system.
--
-- WHY stage-based: Tasks flow through a pipeline from intake to completion.
-- WHY priority numbers: Lower = more urgent. Allows fine-grained ordering.
-- WHY owner tracking: Enables delegation to spawned monks.

INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('ai.task', 'system', 'AI task queue with priority-based scheduling');

CREATE TABLE IF NOT EXISTS ai_task (
    -- Identity
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    trashed_at      TEXT,
    expired_at      TEXT,

    -- Task content
    title           TEXT NOT NULL,
    description     TEXT,

    -- Priority (1=critical, 5=normal, 9=idle)
    -- WHY 1-9 scale: Matches ONI's 9-level priority system.
    priority        INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),

    -- Pipeline stage
    -- backlog: needs to be done
    -- selected: agent wants to work on this
    -- active: in flight, agent working directly
    -- delegated: spawned monk is handling it
    -- review: done but not reviewed
    -- release: ready for user/output
    -- done: complete
    -- failed: terminal failure
    stage           TEXT NOT NULL DEFAULT 'backlog' CHECK (stage IN (
                        'backlog', 'selected', 'active', 'delegated',
                        'review', 'release', 'done', 'failed'
                    )),

    -- Ownership
    -- WHY nullable: backlog tasks have no owner yet.
    -- Values: null, 'prior', or spawned monk pid
    owner           TEXT,

    -- Hierarchy
    -- WHY parent_id: Enables task decomposition into subtasks.
    parent_id       TEXT REFERENCES ai_task(id) ON DELETE SET NULL,

    -- Result
    result          TEXT,
    error           TEXT,

    -- Timing
    started_at      TEXT,
    completed_at    TEXT
);

-- Primary queue index: find next task to work on
CREATE INDEX IF NOT EXISTS idx_ai_task_queue
    ON ai_task(stage, priority, created_at)
    WHERE trashed_at IS NULL;

-- Owner index: find tasks by who's working on them
CREATE INDEX IF NOT EXISTS idx_ai_task_owner
    ON ai_task(owner, stage)
    WHERE trashed_at IS NULL AND owner IS NOT NULL;

-- Parent index: find subtasks
CREATE INDEX IF NOT EXISTS idx_ai_task_parent
    ON ai_task(parent_id)
    WHERE trashed_at IS NULL AND parent_id IS NOT NULL;

-- =============================================================================
-- SEED DATA: AI_TASK FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (
    model_name, field_name, type, required, default_value, enum_values,
    relationship_type, related_model, related_field, required_relationship,
    unique_, index_, description
) VALUES
    ('ai.task', 'title', 'text', 1, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Brief task description'),
    ('ai.task', 'description', 'text', 0, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Detailed task requirements'),
    ('ai.task', 'priority', 'integer', 1, '5', NULL,
     NULL, NULL, NULL, 0,
     0, 1, 'Priority 1-9 (1=critical, 5=normal, 9=idle)'),
    ('ai.task', 'stage', 'text', 1, 'backlog', '["backlog","selected","active","delegated","review","release","done","failed"]',
     NULL, NULL, NULL, 0,
     0, 1, 'Pipeline stage'),
    ('ai.task', 'owner', 'text', 0, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 1, 'Who is working on this (null, prior, or monk pid)'),
    ('ai.task', 'parent_id', 'text', 0, NULL, NULL,
     'referenced', 'ai.task', 'id', 0,
     0, 1, 'Parent task for subtask hierarchy'),
    ('ai.task', 'result', 'text', 0, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Task output/result'),
    ('ai.task', 'error', 'text', 0, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'Error message if failed'),
    ('ai.task', 'started_at', 'text', 0, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'When work began'),
    ('ai.task', 'completed_at', 'text', 0, NULL, NULL,
     NULL, NULL, NULL, 0,
     0, 0, 'When work finished');

-- =============================================================================
-- AI_STM TABLE (Short-Term Memory)
-- =============================================================================
-- Raw experiences and observations. The day's events before sleep.
--
-- WHY separate from LTM: Different lifecycle. STM is append-heavy, bulk-deleted.
-- WHY salience: Guides consolidation priority - not everything is worth keeping.

INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('ai.stm', 'system', 'Short-term memory - raw experiences awaiting consolidation');

CREATE TABLE IF NOT EXISTS ai_stm (
    -- Identity
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at      TEXT DEFAULT (datetime('now')),
    trashed_at      TEXT,

    -- Content
    content         TEXT NOT NULL,

    -- Context: where did this come from?
    -- WHY JSON: Flexible structure - task_id, conversation_id, source, etc.
    context         TEXT,

    -- Salience: how notable is this? (1=trivial, 5=normal, 9=critical)
    -- WHY salience: Consolidation prioritizes high-salience memories.
    salience        INTEGER NOT NULL DEFAULT 5 CHECK (salience BETWEEN 1 AND 9),

    -- Consolidation tracking
    -- WHY consolidated flag: Marks entries processed during "sleep".
    consolidated    INTEGER NOT NULL DEFAULT 0,
    consolidated_at TEXT
);

-- Consolidation queue: find unprocessed memories by salience
CREATE INDEX IF NOT EXISTS idx_ai_stm_consolidation
    ON ai_stm(consolidated, salience DESC, created_at)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- SEED DATA: AI_STM FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (
    model_name, field_name, type, required, default_value, enum_values,
    unique_, index_, description
) VALUES
    ('ai.stm', 'content', 'text', 1, NULL, NULL,
     0, 0, 'Raw memory content'),
    ('ai.stm', 'context', 'text', 0, NULL, NULL,
     0, 0, 'JSON context (task_id, source, etc.)'),
    ('ai.stm', 'salience', 'integer', 1, '5', NULL,
     0, 1, 'Salience 1-9 (1=trivial, 9=critical)'),
    ('ai.stm', 'consolidated', 'boolean', 1, '0', NULL,
     0, 1, 'Has been processed during consolidation'),
    ('ai.stm', 'consolidated_at', 'text', 0, NULL, NULL,
     0, 0, 'When consolidation occurred');

-- =============================================================================
-- AI_LTM TABLE (Long-Term Memory)
-- =============================================================================
-- Distilled knowledge that survives consolidation. What matters.
--
-- WHY reinforced count: Memories encountered multiple times are stronger.
-- WHY last_accessed: Enables decay - unused memories fade.
-- WHY source_ids: Provenance tracking back to original STM entries.

INSERT OR IGNORE INTO models (model_name, status, description) VALUES
    ('ai.ltm', 'system', 'Long-term memory - consolidated knowledge and insights');

CREATE TABLE IF NOT EXISTS ai_ltm (
    -- Identity
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    trashed_at      TEXT,
    expired_at      TEXT,

    -- Content
    content         TEXT NOT NULL,

    -- Classification
    -- WHY category: Enables scoped retrieval (just user prefs, just project facts).
    category        TEXT,

    -- Provenance
    -- WHY JSON array: A single LTM entry may distill multiple STM entries.
    source_ids      TEXT,

    -- Strength
    -- WHY reinforced: Memories re-encountered during consolidation get stronger.
    reinforced      INTEGER NOT NULL DEFAULT 1,

    -- Access tracking
    -- WHY last_accessed: Memories that aren't retrieved may decay/archive.
    last_accessed   TEXT
);

-- Category index: find memories by type
CREATE INDEX IF NOT EXISTS idx_ai_ltm_category
    ON ai_ltm(category)
    WHERE trashed_at IS NULL AND category IS NOT NULL;

-- Reinforcement index: find strongest memories
CREATE INDEX IF NOT EXISTS idx_ai_ltm_strength
    ON ai_ltm(reinforced DESC)
    WHERE trashed_at IS NULL;

-- Decay index: find stale memories for potential archival
CREATE INDEX IF NOT EXISTS idx_ai_ltm_access
    ON ai_ltm(last_accessed)
    WHERE trashed_at IS NULL;

-- =============================================================================
-- SEED DATA: AI_LTM FIELDS
-- =============================================================================

INSERT OR IGNORE INTO fields (
    model_name, field_name, type, required, default_value, enum_values,
    unique_, index_, description
) VALUES
    ('ai.ltm', 'content', 'text', 1, NULL, NULL,
     0, 0, 'Consolidated memory content'),
    ('ai.ltm', 'category', 'text', 0, NULL, NULL,
     0, 1, 'Memory category (user_prefs, project_facts, lessons, etc.)'),
    ('ai.ltm', 'source_ids', 'text', 0, NULL, NULL,
     0, 0, 'JSON array of source STM ids'),
    ('ai.ltm', 'reinforced', 'integer', 1, '1', NULL,
     0, 1, 'Reinforcement count (higher = stronger)'),
    ('ai.ltm', 'last_accessed', 'text', 0, NULL, NULL,
     0, 1, 'Last retrieval timestamp (for decay)');
