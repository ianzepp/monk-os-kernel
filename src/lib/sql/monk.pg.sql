-- Infrastructure Schema (PostgreSQL)
-- Manages the tenants registry in the public schema

-- Tenant fixtures tracking
CREATE TABLE IF NOT EXISTS "tenant_fixtures" (
    "tenant_id" uuid NOT NULL,
    "fixture_name" VARCHAR(255) NOT NULL,
    "deployed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY ("tenant_id", "fixture_name")
);

CREATE INDEX IF NOT EXISTS "idx_tenant_fixtures_tenant" ON "tenant_fixtures" ("tenant_id");
CREATE INDEX IF NOT EXISTS "idx_tenant_fixtures_fixture" ON "tenant_fixtures" ("fixture_name");

-- Tenants registry
CREATE TABLE IF NOT EXISTS "tenants" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "db_type" VARCHAR(20) DEFAULT 'postgresql' NOT NULL CHECK ("db_type" IN ('postgresql', 'sqlite')),
    "database" VARCHAR(255) NOT NULL,
    "schema" VARCHAR(255) NOT NULL,
    "template_version" INTEGER DEFAULT 1 NOT NULL,
    "description" TEXT,
    "source_template" VARCHAR(255),
    "owner_id" uuid NOT NULL,
    "is_active" BOOLEAN DEFAULT true NOT NULL,
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TIMESTAMP,
    "deleted_at" TIMESTAMP,
    CONSTRAINT "tenants_database_schema_unique" UNIQUE("database", "schema")
);

CREATE INDEX IF NOT EXISTS "idx_tenants_name_active" ON "tenants" ("name", "is_active");
CREATE INDEX IF NOT EXISTS "idx_tenants_database" ON "tenants" ("database");
CREATE INDEX IF NOT EXISTS "idx_tenants_owner" ON "tenants" ("owner_id");

-- Foreign key (added after both tables exist)
DO $$ BEGIN
    ALTER TABLE "tenant_fixtures"
        ADD CONSTRAINT "tenant_fixtures_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Processes table (server-wide background jobs and tasks)
-- Modeled after Linux /proc filesystem
CREATE TABLE IF NOT EXISTS "processes" (
    -- Identity
    "pid" serial PRIMARY KEY,
    "ppid" integer REFERENCES "processes"("pid") ON DELETE SET NULL,

    -- Connection context (denormalized for self-contained execution)
    "tenant" text NOT NULL,
    "db_type" text NOT NULL CHECK ("db_type" IN ('postgresql', 'sqlite')),
    "db_name" text NOT NULL,
    "ns_name" text NOT NULL,

    -- Ownership (like uid/gid)
    "uid" text NOT NULL,
    "access" text NOT NULL CHECK ("access" IN ('root', 'full', 'edit', 'read', 'deny')),

    -- State: R=running, S=sleeping, Z=zombie, T=stopped, X=dead
    "state" char(1) NOT NULL DEFAULT 'R' CHECK ("state" IN ('R', 'S', 'Z', 'T', 'X')),
    "exit_code" integer,

    -- Command
    "comm" text NOT NULL,
    "cmdline" text[] NOT NULL,
    "cwd" text NOT NULL DEFAULT '/',
    "environ" jsonb,

    -- Timing
    "created_at" timestamp DEFAULT now() NOT NULL,
    "started_at" timestamp,
    "ended_at" timestamp,

    -- I/O (file descriptors 0, 1, 2)
    "stdin" text,
    "stdout" text,
    "stderr" text,

    -- Extensions
    "type" text NOT NULL DEFAULT 'command' CHECK ("type" IN ('command', 'script', 'cron', 'daemon')),
    "cron_expr" text,
    "next_run_at" timestamp,
    "error" text
);

CREATE INDEX IF NOT EXISTS "idx_processes_tenant" ON "processes" ("tenant");
CREATE INDEX IF NOT EXISTS "idx_processes_state" ON "processes" ("state") WHERE "state" IN ('R', 'S');
CREATE INDEX IF NOT EXISTS "idx_processes_ppid" ON "processes" ("ppid") WHERE "ppid" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_processes_cron" ON "processes" ("next_run_at") WHERE "type" = 'cron' AND "state" != 'X';
