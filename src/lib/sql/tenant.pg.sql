-- Tenant Schema (PostgreSQL)
-- Core tables for each tenant namespace: models, fields, users, filters

-- Enable pgcrypto extension for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create enum type for field data types
DO $$ BEGIN
    CREATE TYPE field_type AS ENUM (
        'text', 'integer', 'bigint', 'bigserial', 'numeric', 'boolean',
        'jsonb', 'uuid', 'timestamp', 'date', 'binary',
        'text[]', 'integer[]', 'numeric[]', 'uuid[]'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Models table
CREATE TABLE IF NOT EXISTS "models" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    "model_name" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "description" text,
    "sudo" boolean DEFAULT false NOT NULL,
    "frozen" boolean DEFAULT false NOT NULL,
    "immutable" boolean DEFAULT false NOT NULL,
    "external" boolean DEFAULT false NOT NULL,
    "passthrough" boolean DEFAULT false NOT NULL,
    CONSTRAINT "model_name_unique" UNIQUE("model_name")
);

-- Fields table
CREATE TABLE IF NOT EXISTS "fields" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    "model_name" text NOT NULL,
    "field_name" text NOT NULL,
    "type" field_type NOT NULL,
    "required" boolean DEFAULT false NOT NULL,
    "default_value" text,
    "description" text,
    "relationship_type" text,
    "related_model" text,
    "related_field" text,
    "relationship_name" text,
    "cascade_delete" boolean DEFAULT false,
    "required_relationship" boolean DEFAULT false,
    "minimum" numeric,
    "maximum" numeric,
    "pattern" text,
    "enum_values" text[],
    "is_array" boolean DEFAULT false,
    "immutable" boolean DEFAULT false NOT NULL,
    "sudo" boolean DEFAULT false NOT NULL,
    "unique" boolean DEFAULT false NOT NULL,
    "index" boolean DEFAULT false NOT NULL,
    "tracked" boolean DEFAULT false NOT NULL,
    "searchable" boolean DEFAULT false NOT NULL,
    "transform" text
);

ALTER TABLE "fields" DROP CONSTRAINT IF EXISTS "fields_models_name_model_name_fk";
ALTER TABLE "fields" ADD CONSTRAINT "fields_models_name_model_name_fk"
    FOREIGN KEY ("model_name") REFERENCES "models"("model_name")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_fields_model_field"
    ON "fields" ("model_name", "field_name");

-- Users table
CREATE TABLE IF NOT EXISTS "users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "auth" text NOT NULL,
    "access" text CHECK ("access" IN ('root', 'full', 'edit', 'read', 'deny')) NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    CONSTRAINT "users_auth_unique" UNIQUE("auth")
);

-- Filters table
CREATE TABLE IF NOT EXISTS "filters" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    "name" text NOT NULL,
    "model_name" text NOT NULL,
    "description" text,
    "select" jsonb,
    "where" jsonb,
    "order" jsonb,
    "limit" integer,
    "offset" integer
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_filters_model_name"
    ON "filters" ("model_name", "name");

ALTER TABLE "filters" DROP CONSTRAINT IF EXISTS "filters_models_model_name_fk";
ALTER TABLE "filters" ADD CONSTRAINT "filters_models_model_name_fk"
    FOREIGN KEY ("model_name") REFERENCES "models"("model_name")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Credentials table (passwords, API keys, OAuth tokens)
CREATE TABLE IF NOT EXISTS "credentials" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    "user_id" uuid NOT NULL,
    "type" text NOT NULL CHECK ("type" IN ('password', 'api_key')),
    "identifier" text,
    "secret" text NOT NULL,
    "algorithm" text,
    "permissions" text,
    "name" text,
    "expires_at" timestamp,
    "last_used_at" timestamp,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_credentials_user_type"
    ON "credentials" ("user_id", "type", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_credentials_identifier"
    ON "credentials" ("type", "identifier") WHERE "identifier" IS NOT NULL;

-- Tracked table (change tracking and audit trails)
CREATE TABLE IF NOT EXISTS "tracked" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    "change_id" bigserial NOT NULL,
    "model_name" text NOT NULL,
    "record_id" uuid NOT NULL,
    "operation" text NOT NULL,
    "changes" jsonb NOT NULL,
    "created_by" uuid,
    "request_id" text,
    "metadata" jsonb
);

CREATE INDEX IF NOT EXISTS "idx_tracked_model_record"
    ON "tracked" (model_name, record_id, change_id DESC);

-- FS Nodes table (filesystem storage)
CREATE TABLE IF NOT EXISTS "fs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    "parent_id" uuid,
    "name" text NOT NULL,
    "path" text NOT NULL,
    "node_type" text NOT NULL CHECK ("node_type" IN ('file', 'directory', 'symlink')),
    "content" bytea,
    "target" text,
    "mode" integer DEFAULT 420 NOT NULL,
    "size" integer DEFAULT 0 NOT NULL,
    "owner_id" uuid,
    CONSTRAINT "fs_path_unique" UNIQUE("path"),
    FOREIGN KEY ("parent_id") REFERENCES "fs"("id") ON DELETE CASCADE,
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_fs_parent" ON "fs" ("parent_id");
CREATE INDEX IF NOT EXISTS "idx_fs_path" ON "fs" ("path");

-- =============================================================================
-- SEED DATA
-- =============================================================================

-- Register core models
INSERT INTO "models" (model_name, status, sudo, description) VALUES
    ('models', 'system', true, NULL),
    ('fields', 'system', true, NULL),
    ('users', 'system', true, NULL),
    ('filters', 'system', false, NULL),
    ('credentials', 'system', true, 'User authentication credentials'),
    ('tracked', 'system', true, 'Change tracking and audit trail'),
    ('fs', 'system', true, 'Filesystem nodes')
ON CONFLICT (model_name) DO NOTHING;

-- Fields for models
INSERT INTO "fields" (model_name, field_name, type, required, default_value, description) VALUES
    ('models', 'model_name', 'text', true, NULL, 'Unique name for the model'),
    ('models', 'status', 'text', false, 'active', 'Model status (active, disabled, system)'),
    ('models', 'description', 'text', false, NULL, 'Human-readable description of the model'),
    ('models', 'sudo', 'boolean', false, NULL, 'Whether model modifications require sudo access'),
    ('models', 'frozen', 'boolean', false, NULL, 'Whether all data changes are prevented on this model'),
    ('models', 'immutable', 'boolean', false, NULL, 'Whether records are write-once'),
    ('models', 'external', 'boolean', false, NULL, 'Whether model is managed externally')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- Fields for fields
INSERT INTO "fields" (model_name, field_name, type, required, description) VALUES
    ('fields', 'model_name', 'text', true, 'Name of the model this field belongs to'),
    ('fields', 'field_name', 'text', true, 'Name of the field'),
    ('fields', 'type', 'text', true, 'Data type of the field'),
    ('fields', 'required', 'boolean', false, 'Whether the field is required'),
    ('fields', 'default_value', 'text', false, 'Default value for the field'),
    ('fields', 'description', 'text', false, 'Human-readable description'),
    ('fields', 'relationship_type', 'text', false, 'Type of relationship'),
    ('fields', 'related_model', 'text', false, 'Related model for relationships'),
    ('fields', 'related_field', 'text', false, 'Related field for relationships'),
    ('fields', 'relationship_name', 'text', false, 'Name of the relationship'),
    ('fields', 'cascade_delete', 'boolean', false, 'Whether to cascade delete'),
    ('fields', 'required_relationship', 'boolean', false, 'Whether the relationship is required'),
    ('fields', 'minimum', 'numeric', false, 'Minimum value constraint'),
    ('fields', 'maximum', 'numeric', false, 'Maximum value constraint'),
    ('fields', 'pattern', 'text', false, 'Regular expression pattern'),
    ('fields', 'enum_values', 'text[]', false, 'Allowed enum values'),
    ('fields', 'is_array', 'boolean', false, 'Whether the field is an array'),
    ('fields', 'immutable', 'boolean', false, 'Whether the field value cannot be changed'),
    ('fields', 'sudo', 'boolean', false, 'Whether modifying requires sudo'),
    ('fields', 'unique', 'boolean', false, 'Whether values must be unique'),
    ('fields', 'index', 'boolean', false, 'Whether to create an index'),
    ('fields', 'tracked', 'boolean', false, 'Whether changes are tracked'),
    ('fields', 'searchable', 'boolean', false, 'Whether full-text search is enabled'),
    ('fields', 'transform', 'text', false, 'Auto-transform values')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- Fields for users
INSERT INTO "fields" (model_name, field_name, type, required, description) VALUES
    ('users', 'name', 'text', true, 'User display name'),
    ('users', 'auth', 'text', true, 'Authentication identifier'),
    ('users', 'access', 'text', true, 'User access level')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- Fields for filters
INSERT INTO "fields" (model_name, field_name, type, required, description) VALUES
    ('filters', 'name', 'text', true, 'Unique name for this saved filter'),
    ('filters', 'model_name', 'text', true, 'Target model'),
    ('filters', 'description', 'text', false, 'Human-readable description'),
    ('filters', 'select', 'jsonb', false, 'Fields to return'),
    ('filters', 'where', 'jsonb', false, 'Filter conditions'),
    ('filters', 'order', 'jsonb', false, 'Sort order'),
    ('filters', 'limit', 'integer', false, 'Maximum records'),
    ('filters', 'offset', 'integer', false, 'Records to skip')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- Fields for credentials
INSERT INTO "fields" (model_name, field_name, type, required, description) VALUES
    ('credentials', 'user_id', 'uuid', true, 'Reference to the user who owns this credential'),
    ('credentials', 'type', 'text', true, 'Credential type: password, api_key'),
    ('credentials', 'identifier', 'text', false, 'Public identifier (API key prefix)'),
    ('credentials', 'secret', 'text', true, 'Hashed secret value'),
    ('credentials', 'algorithm', 'text', false, 'Hashing algorithm used'),
    ('credentials', 'permissions', 'text', false, 'JSON permissions for API keys'),
    ('credentials', 'name', 'text', false, 'Friendly name for the credential'),
    ('credentials', 'expires_at', 'timestamp', false, 'Expiration timestamp'),
    ('credentials', 'last_used_at', 'timestamp', false, 'Last usage timestamp')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- Fields for tracked
INSERT INTO "fields" (model_name, field_name, type, required, description) VALUES
    ('tracked', 'change_id', 'bigserial', true, 'Auto-incrementing change identifier for ordering'),
    ('tracked', 'model_name', 'text', true, 'Name of the model where the change occurred'),
    ('tracked', 'record_id', 'uuid', true, 'ID of the record that was changed'),
    ('tracked', 'operation', 'text', true, 'Operation type: create, update, or delete'),
    ('tracked', 'changes', 'jsonb', true, 'Field-level changes with old and new values'),
    ('tracked', 'created_by', 'uuid', false, 'ID of the user who made the change'),
    ('tracked', 'request_id', 'text', false, 'Request correlation ID for tracing'),
    ('tracked', 'metadata', 'jsonb', false, 'Additional context (IP address, user agent, etc.)')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- Fields for fs
INSERT INTO "fields" (model_name, field_name, type, required, description) VALUES
    ('fs', 'parent_id', 'uuid', false, 'Parent directory (null for root)'),
    ('fs', 'name', 'text', true, 'File or directory name'),
    ('fs', 'path', 'text', true, 'Full absolute path'),
    ('fs', 'node_type', 'text', true, 'Node type: file, directory, symlink'),
    ('fs', 'content', 'binary', false, 'File content (null for directories)'),
    ('fs', 'target', 'text', false, 'Symlink target path'),
    ('fs', 'mode', 'integer', false, 'Unix permission bits'),
    ('fs', 'size', 'integer', false, 'Content size in bytes'),
    ('fs', 'owner_id', 'uuid', false, 'Owner user ID')
ON CONFLICT (model_name, field_name) DO NOTHING;

-- =============================================================================
-- LONG TERM MEMORY (LTM)
-- =============================================================================

-- Memories table (long-term memory for AI agents)
CREATE TABLE IF NOT EXISTS "memories" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "access_read" uuid[] DEFAULT '{}'::uuid[],
    "access_edit" uuid[] DEFAULT '{}'::uuid[],
    "access_full" uuid[] DEFAULT '{}'::uuid[],
    "access_deny" uuid[] DEFAULT '{}'::uuid[],
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "trashed_at" timestamp,
    "deleted_at" timestamp,
    "owner" text NOT NULL,
    "content" text NOT NULL
);

-- Full-text search index on content
CREATE INDEX IF NOT EXISTS "idx_memories_content_search"
    ON "memories" USING GIN (to_tsvector('english', "content"));

-- Index for owner lookup
CREATE INDEX IF NOT EXISTS "idx_memories_owner"
    ON "memories" ("owner", "created_at" DESC);

-- Register memories model
INSERT INTO "models" (model_name, status, description) VALUES
    ('memories', 'system', 'Long-term memory storage for AI agents')
ON CONFLICT (model_name) DO NOTHING;

-- Fields for memories
INSERT INTO "fields" (model_name, field_name, type, required, searchable, description) VALUES
    ('memories', 'owner', 'text', true, false, 'Username who owns this memory'),
    ('memories', 'content', 'text', true, true, 'Memory content (full-text searchable)')
ON CONFLICT (model_name, field_name) DO NOTHING;
