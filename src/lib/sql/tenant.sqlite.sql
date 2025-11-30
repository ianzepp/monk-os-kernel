-- Tenant Schema (SQLite)
-- Core tables for each tenant namespace: models, fields, users, filters

-- Models table
CREATE TABLE IF NOT EXISTS "models" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    "model_name" TEXT NOT NULL,
    "status" TEXT DEFAULT 'active' NOT NULL,
    "description" TEXT,
    "sudo" INTEGER DEFAULT 0 NOT NULL,
    "frozen" INTEGER DEFAULT 0 NOT NULL,
    "immutable" INTEGER DEFAULT 0 NOT NULL,
    "external" INTEGER DEFAULT 0 NOT NULL,
    "passthrough" INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT "model_name_unique" UNIQUE("model_name")
);

-- Fields table
CREATE TABLE IF NOT EXISTS "fields" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    "model_name" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN (
        'text', 'integer', 'bigint', 'bigserial', 'numeric', 'boolean',
        'jsonb', 'uuid', 'timestamp', 'date', 'binary',
        'text[]', 'integer[]', 'numeric[]', 'uuid[]'
    )),
    "required" INTEGER DEFAULT 0 NOT NULL,
    "default_value" TEXT,
    "description" TEXT,
    "relationship_type" TEXT,
    "related_model" TEXT,
    "related_field" TEXT,
    "relationship_name" TEXT,
    "cascade_delete" INTEGER DEFAULT 0,
    "required_relationship" INTEGER DEFAULT 0,
    "minimum" REAL,
    "maximum" REAL,
    "pattern" TEXT,
    "enum_values" TEXT,
    "is_array" INTEGER DEFAULT 0,
    "immutable" INTEGER DEFAULT 0 NOT NULL,
    "sudo" INTEGER DEFAULT 0 NOT NULL,
    "unique" INTEGER DEFAULT 0 NOT NULL,
    "index" INTEGER DEFAULT 0 NOT NULL,
    "tracked" INTEGER DEFAULT 0 NOT NULL,
    "searchable" INTEGER DEFAULT 0 NOT NULL,
    "transform" TEXT,
    FOREIGN KEY ("model_name") REFERENCES "models"("model_name")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_fields_model_field" ON "fields" ("model_name", "field_name");

-- Users table
CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "access" TEXT CHECK ("access" IN ('root', 'full', 'edit', 'read', 'deny')) NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    CONSTRAINT "users_auth_unique" UNIQUE("auth")
);

-- Filters table
CREATE TABLE IF NOT EXISTS "filters" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    "name" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "description" TEXT,
    "select" TEXT,
    "where" TEXT,
    "order" TEXT,
    "limit" INTEGER,
    "offset" INTEGER,
    FOREIGN KEY ("model_name") REFERENCES "models"("model_name") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_filters_model_name" ON "filters" ("model_name", "name");

-- Credentials table (passwords, API keys, OAuth tokens)
CREATE TABLE IF NOT EXISTS "credentials" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('password', 'api_key')),
    "identifier" TEXT,
    "secret" TEXT NOT NULL,
    "algorithm" TEXT,
    "permissions" TEXT,
    "name" TEXT,
    "expires_at" TEXT,
    "last_used_at" TEXT,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_credentials_user_type"
    ON "credentials" ("user_id", "type", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_credentials_identifier"
    ON "credentials" ("type", "identifier");

-- Tracked table (change tracking and audit trails)
-- Note: change_id uses INTEGER PRIMARY KEY for auto-increment in SQLite
-- The "id" field is kept for API compatibility but change_id is the actual PK
CREATE TABLE IF NOT EXISTS "tracked" (
    "change_id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    "model_name" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "changes" TEXT NOT NULL,
    "created_by" TEXT,
    "request_id" TEXT,
    "metadata" TEXT
);

CREATE INDEX IF NOT EXISTS "idx_tracked_model_record" ON "tracked" (model_name, record_id, change_id DESC);

-- FS Nodes table (filesystem storage)
CREATE TABLE IF NOT EXISTS "fs" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "node_type" TEXT NOT NULL CHECK ("node_type" IN ('file', 'directory', 'symlink')),
    "content" BLOB,
    "target" TEXT,
    "mode" INTEGER DEFAULT 420 NOT NULL,
    "size" INTEGER DEFAULT 0 NOT NULL,
    "owner_id" TEXT,
    CONSTRAINT "fs_path_unique" UNIQUE("path"),
    FOREIGN KEY ("parent_id") REFERENCES "fs"("id") ON DELETE CASCADE,
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_fs_parent" ON "fs" ("parent_id");
CREATE INDEX IF NOT EXISTS "idx_fs_path" ON "fs" ("path");

-- =============================================================================
-- LONG TERM MEMORY (LTM)
-- =============================================================================

-- Memories table (long-term memory for AI agents)
CREATE TABLE IF NOT EXISTS "memories" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "access_read" TEXT DEFAULT '[]',
    "access_edit" TEXT DEFAULT '[]',
    "access_full" TEXT DEFAULT '[]',
    "access_deny" TEXT DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    "owner" TEXT NOT NULL,
    "content" TEXT NOT NULL
);

-- Index for owner lookup (FTS handled via LIKE for SQLite)
CREATE INDEX IF NOT EXISTS "idx_memories_owner" ON "memories" ("owner", "created_at" DESC);

-- =============================================================================
-- NOTE: Seed data for SQLite is managed in src/lib/infrastructure.ts
-- (TENANT_SEED_SQLITE constant) to allow dynamic UUID generation at runtime.
-- PostgreSQL seed data is in tenant.pg.sql using gen_random_uuid().
-- =============================================================================
