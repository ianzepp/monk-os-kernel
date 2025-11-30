-- Infrastructure Schema (SQLite)
-- Manages the tenants registry in the public database

-- Tenant fixtures tracking
CREATE TABLE IF NOT EXISTS "tenant_fixtures" (
    "tenant_id" TEXT NOT NULL,
    "fixture_name" TEXT NOT NULL,
    "deployed_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY ("tenant_id", "fixture_name")
);

CREATE INDEX IF NOT EXISTS "idx_tenant_fixtures_tenant" ON "tenant_fixtures" ("tenant_id");
CREATE INDEX IF NOT EXISTS "idx_tenant_fixtures_fixture" ON "tenant_fixtures" ("fixture_name");

-- Tenants registry
CREATE TABLE IF NOT EXISTS "tenants" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL UNIQUE,
    "db_type" TEXT DEFAULT 'sqlite' NOT NULL CHECK ("db_type" IN ('postgresql', 'sqlite')),
    "database" TEXT NOT NULL,
    "schema" TEXT NOT NULL,
    "template_version" INTEGER DEFAULT 1 NOT NULL,
    "description" TEXT,
    "source_template" TEXT,
    "owner_id" TEXT NOT NULL,
    "is_active" INTEGER DEFAULT 1 NOT NULL,
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "trashed_at" TEXT,
    "deleted_at" TEXT,
    CONSTRAINT "tenants_database_schema_unique" UNIQUE("database", "schema")
);

CREATE INDEX IF NOT EXISTS "idx_tenants_name_active" ON "tenants" ("name", "is_active");
CREATE INDEX IF NOT EXISTS "idx_tenants_database" ON "tenants" ("database");
CREATE INDEX IF NOT EXISTS "idx_tenants_owner" ON "tenants" ("owner_id");

-- Processes table (server-wide background jobs and tasks)
-- Modeled after Linux /proc filesystem
CREATE TABLE IF NOT EXISTS "processes" (
    -- Identity
    "pid" INTEGER PRIMARY KEY AUTOINCREMENT,
    "ppid" INTEGER REFERENCES "processes"("pid") ON DELETE SET NULL,

    -- Connection context (denormalized for self-contained execution)
    "tenant" TEXT NOT NULL,
    "db_type" TEXT NOT NULL CHECK ("db_type" IN ('postgresql', 'sqlite')),
    "db_name" TEXT NOT NULL,
    "ns_name" TEXT NOT NULL,

    -- Ownership (like uid/gid)
    "uid" TEXT NOT NULL,
    "access" TEXT NOT NULL CHECK ("access" IN ('root', 'full', 'edit', 'read', 'deny')),

    -- State: R=running, S=sleeping, Z=zombie, T=stopped, X=dead
    "state" TEXT NOT NULL DEFAULT 'R' CHECK ("state" IN ('R', 'S', 'Z', 'T', 'X')),
    "exit_code" INTEGER,

    -- Command
    "comm" TEXT NOT NULL,
    "cmdline" TEXT NOT NULL,
    "cwd" TEXT NOT NULL DEFAULT '/',
    "environ" TEXT,

    -- Timing
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "started_at" TEXT,
    "ended_at" TEXT,

    -- I/O (file descriptors 0, 1, 2)
    "stdin" TEXT,
    "stdout" TEXT,
    "stderr" TEXT,

    -- Extensions
    "type" TEXT NOT NULL DEFAULT 'command' CHECK ("type" IN ('command', 'script', 'cron', 'daemon')),
    "cron_expr" TEXT,
    "next_run_at" TEXT,
    "error" TEXT
);

CREATE INDEX IF NOT EXISTS "idx_processes_tenant" ON "processes" ("tenant");
CREATE INDEX IF NOT EXISTS "idx_processes_state" ON "processes" ("state") WHERE "state" IN ('R', 'S');
CREATE INDEX IF NOT EXISTS "idx_processes_ppid" ON "processes" ("ppid") WHERE "ppid" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_processes_cron" ON "processes" ("next_run_at") WHERE "type" = 'cron' AND "state" != 'X';
