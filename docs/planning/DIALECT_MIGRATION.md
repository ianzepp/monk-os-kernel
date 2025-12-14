# Dialect Migration Plan

## Executive Summary

This document tracks the migration to support multiple database dialects (SQLite and PostgreSQL) in the EMS observer pipeline.

## Current Status

### Completed

#### Phase 1: Foundation (v0.6.0/v0.7.0)
- Apps: displayd, crond, timerd, agentd
- Coreutils: env, bc, test, kill, ps, timeout, xargs, base64, etc.
- AI refactoring and wake cycle
- Model field consolidation (indexed)

#### Phase 2: Boot Refactoring
- Split OS/Kernel boot into `init()` and `boot()` phases
- `init()`: Initialize subsystems, VFS/EMS functional
- `boot()`: Activate services, start processes
- Kernel process as PID 1 (no /bin/true placeholder needed)
- Backward compatible: `boot()` auto-calls `init()` if not initialized

#### Phase 4: Dialect Abstraction
**Implemented without requiring Phase 3 (Schema Extraction)**

Created `src/ems/dialect.ts` with:
- `DatabaseDialect` interface
- `SqliteDialect` implementation
- `PostgresDialect` implementation
- `getDialect(name)` factory function

Dialect capabilities:
| Method | SQLite | PostgreSQL |
|--------|--------|------------|
| `placeholder(n)` | `?` | `$n` |
| `placeholders(n)` | `?, ?, ?` | `$1, $2, $3` |
| `beginTransaction()` | `BEGIN IMMEDIATE` | `BEGIN` |
| `createTable(name)` | SQLite DDL | PostgreSQL DDL |
| `addColumn(table, col, type)` | SQLite types | PostgreSQL types |
| `sqlType(fieldType)` | TEXT, INTEGER, REAL, BLOB | TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ, etc. |
| `toDatabase(value, type)` | JS → SQLite conversion | JS → PostgreSQL conversion |
| `fromDatabase(value, type)` | SQLite → JS conversion | PostgreSQL → JS conversion |

Integration:
- `DatabaseConnection.dialect` - dialect instance derived from channel protocol
- `DatabaseAdapter.dialect` - interface requires dialect property
- Observers access via `context.system.db.dialect`

Updated observers:
| Ring | Observer | Dialect Usage |
|------|----------|---------------|
| 5 | SqlCreate | `dialect.placeholders()` for INSERT |
| 5 | SqlUpdate | `dialect.placeholder()`, `dialect.beginTransaction()` |
| 5 | SqlDelete | `dialect.placeholder()` for UPDATE WHERE |
| 6 | DdlCreateModel | `dialect.createTable()` |
| 6 | DdlCreateField | `dialect.addColumn()` |

#### Debug Infrastructure
- Created `src/debug.ts` for kernel-side debug logging
- Created `src/syscall/debug.ts` for debug syscalls
- Created `rom/lib/process/debug.ts` for userspace debug logging
- Pattern matching via DEBUG= environment variable

### Remaining Work

#### Phase 3: Schema Extraction (Optional)
Not required for dialect support, but may be useful for:
- Extracting VFS/Auth/LLM models to JSON files
- Adding `EMS.importModel()` for programmatic model registration
- Removing raw SQL schema files from subsystems

**Known Issue**: If pursued, `spec/helpers/test-os.ts` references `src/vfs/schema.sql` which would need updating.

#### Phase 5: Polish
- Wire up debug logging (infrastructure exists but not connected)
- Test PostgreSQL connection end-to-end
- Fix any remaining boolean type validation issues

## Architecture

```
Observer Code
    │
    ├── Uses db.dialect.placeholder() for SQL parameters
    ├── Uses db.dialect.createTable() for DDL
    ├── Uses db.dialect.toDatabase() for value conversion
    │
    ▼
DatabaseConnection
    │
    ├── dialect: DatabaseDialect (SqliteDialect or PostgresDialect)
    ├── Derived from channel.proto ('sqlite' or 'postgres')
    │
    ▼
HAL Channel
    │
    ├── sqlite:// → bun:sqlite
    └── postgres:// → pg driver
```

## Success Criteria

- [x] All 2052+ tests pass
- [x] Boot works with SQLite (default)
- [x] Ring 5/6 observers use dialect abstraction
- [x] No hardcoded SQLite-specific SQL in observers
- [ ] Boot works with PostgreSQL (needs end-to-end testing)
- [ ] DEBUG= logging wired up and functional

## Commits

Key commits implementing dialect support:
- `93ecb7d` feat: Add DatabaseDialect abstraction for SQLite/PostgreSQL support
- Ring 5 observers updated to use dialect (parallel work)
- `0f2f38f` refactor: Use dialect for Ring 6 DDL observers
