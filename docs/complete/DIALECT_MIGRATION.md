# Dialect Migration - Complete

## Summary

Migration to support multiple database dialects (SQLite and PostgreSQL) in the EMS observer pipeline is complete.

## Implementation

### Dialect Abstraction (`src/hal/dialect.ts`)

Created unified dialect interface with two implementations:
- `SqliteDialect` - SQLite-specific SQL and type handling
- `PostgresDialect` - PostgreSQL-specific SQL and type handling
- `getDialect(name)` - Factory function

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
| `tableName(modelName)` | Dots → underscores | Dots → underscores |
| `arrayContains(col, idx)` | JSON via json_each | ANY() operator |

### Integration

- `DatabaseConnection.dialect` (`src/hal/connection.ts:144`) - Dialect derived from channel protocol
- `DatabaseAdapter.dialect` (`src/ems/observers/interfaces.ts`) - Interface requires dialect
- Observers access via `context.system.db.dialect`

### Updated Observers

| Ring | Observer | Dialect Usage |
|------|----------|---------------|
| 5 | SqlCreate | `dialect.placeholders()`, `dialect.tableName()` |
| 5 | SqlUpdate | `dialect.placeholder()`, `dialect.tableName()`, `dialect.beginTransaction()` |
| 5 | SqlDelete | `dialect.placeholder()`, `dialect.tableName()` |
| 6 | DdlCreateModel | `dialect.createTable()` |
| 6 | DdlCreateField | `dialect.addColumn()` |

### Debug Infrastructure

- `src/debug.ts` - Kernel-side debug logging with DEBUG= pattern matching
- `src/dispatch/syscall/debug.ts` - Debug syscalls
- `rom/lib/process/debug.ts` - Userspace debug logging
- Used in gateway and dispatch subsystems

## Architecture

```
Observer Code
    │
    ├── Uses db.dialect.placeholder() for SQL parameters
    ├── Uses db.dialect.createTable() for DDL
    ├── Uses db.dialect.toDatabase() for value conversion
    │
    ▼
DatabaseConnection (src/hal/connection.ts)
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

## Verification

- [x] 2043+ tests pass
- [x] Boot works with SQLite (default)
- [x] Ring 5/6 observers use dialect abstraction
- [x] No hardcoded SQLite-specific SQL in observers
- [x] DEBUG= logging wired up and functional

## Future Work

- PostgreSQL end-to-end boot testing (infrastructure ready, needs validation)
- Phase 3 Schema Extraction (optional): Extract VFS/Auth/LLM models to JSON files

## Related Commits

- `93ecb7d` feat: Add DatabaseDialect abstraction for SQLite/PostgreSQL support
- `0f2f38f` refactor: Use dialect for Ring 6 DDL observers
