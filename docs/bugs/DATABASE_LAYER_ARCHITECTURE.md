# Database Layer Architecture: HAL vs EMS Coupling

## Status
**Open** - Needs architectural decision

## Summary
The database abstraction layer has coupling between "generic SQL" concepts (HAL) and EMS-specific schema knowledge. A refactor to move database primitives to HAL revealed that clean separation isn't straightforward.

## Current State (after partial refactor)

```
src/hal/
  dialect.ts         # SQL dialect abstraction (SQLite/Postgres) - GENERIC
  connection.ts      # DatabaseConnection wrapper - GENERIC
  database-ops.ts    # SQL streaming (query, execute, etc.) - MOSTLY GENERIC
  filter.ts          # Query builder - HAS EMS ASSUMPTIONS
  filter-types.ts    # Filter types - GENERIC

src/ems/
  database.ts        # createDatabase (loads EMS schema.sql) - EMS-SPECIFIC
```

## The Problem

### Filter has EMS knowledge baked in

```typescript
// Hardcoded entity columns
const ENTITY_COLUMNS = new Set(['id', 'model', 'parent', 'pathname']);

// Hardcoded metadata tables
const METADATA_TABLES = new Set([
    'models', 'fields', 'tracked', 'entities',
    'llm_provider', 'llm_model',
]);

// Auto-joins detail tables with entities
`SELECT ... FROM ${tableName} d JOIN entities e ON d.id = e.id`

// Soft-delete handling
'd.trashed_at IS NULL'
```

### DatabaseOps depends on Filter

```typescript
// hal/database-ops.ts
import { Filter } from './filter.js';

async *selectFrom(table, filterData, options) {
    const filter = Filter.from(table, filterData, options);
    // ...
}
```

### Raw SQL scattered with hardcoded placeholders

Several files have raw SQL with `?` placeholders (SQLite-only):

| File | Issue |
|------|-------|
| `hal/database-ops.ts` | INSERT, UPDATE, DELETE use `?` |
| `ems/entity-ops.ts` | INSERT, UPDATE, DELETE use `?` |
| `vfs/path-cache.ts` | SELECT queries use `?` |
| `ems/ring/7/60-tracked.ts` | INSERT uses `?` |
| `hal/filter.ts` | All generated SQL uses `?` |

Ring 5 observers properly use `dialect.placeholder()`, but other code doesn't.

## Options

### Option 1: Everything in EMS
Move all database abstractions back to EMS. HAL provides only raw channel access.

**Pros:**
- Simple, no coupling issues
- EMS owns its schema knowledge

**Cons:**
- HAL-only tests can't use DatabaseOps/Filter
- Less reusable if we ever have non-EMS databases

### Option 2: Split Generic from EMS-Specific

```
src/hal/
  dialect.ts           # Dialect abstraction
  connection.ts        # DatabaseConnection
  sql-builder.ts       # Generic SQL builder (no EMS knowledge)

src/ems/
  filter.ts            # EMS-aware query builder (extends sql-builder?)
  database-ops.ts      # EMS-aware streaming ops
```

**Pros:**
- Clean separation
- HAL is truly generic

**Cons:**
- More code, more complexity
- Need to carefully define the boundary

### Option 3: HAL = Raw SQL Only

```
src/hal/
  dialect.ts           # Dialect abstraction
  connection.ts        # DatabaseConnection (raw query/execute/exec)

src/ems/
  filter.ts            # Query builder
  database-ops.ts      # SQL streaming with Filter
```

**Pros:**
- Clear boundary: HAL = wire protocol, EMS = query building
- DatabaseOps can use Filter freely

**Cons:**
- HAL tests need to write raw SQL
- Dialect translation scattered (some in HAL, some in EMS)

### Option 4: Dialect-Aware Filter in HAL (Remove EMS Assumptions)

Refactor Filter to be truly generic:
- Remove ENTITY_COLUMNS, METADATA_TABLES constants
- Remove auto-join logic
- Remove trashed_at handling
- Add dialect parameter for placeholder generation

EMS creates an `EntityFilter` subclass or wrapper that adds the EMS-specific behavior.

**Pros:**
- Clean separation
- Filter is reusable
- Dialect handling centralized

**Cons:**
- Significant refactor of Filter
- EntityFilter might duplicate a lot of logic

## Dialect Translation Issue

Regardless of where code lives, we have raw SQL with `?` that needs dialect translation:

```typescript
// Current (SQLite-only)
const sql = `INSERT INTO ${table} (${cols}) VALUES (${cols.map(() => '?').join(', ')})`;

// Needed (dialect-aware)
const sql = `INSERT INTO ${table} (${cols}) VALUES (${cols.map((_, i) => dialect.placeholder(i + 1)).join(', ')})`;
```

This affects:
- `hal/database-ops.ts` - insertInto, updateIn, deleteFrom
- `ems/entity-ops.ts` - direct SQL in various methods
- `hal/filter.ts` - all placeholder generation
- `vfs/path-cache.ts` - direct queries

## Recommendation

Leaning toward **Option 3** (HAL = Raw SQL Only) with dialect awareness:

1. Move Filter back to EMS
2. Move DatabaseOps back to EMS (or remove Filter-dependent methods)
3. HAL keeps: dialect, connection (with dialect-aware placeholder helpers)
4. All SQL generation uses dialect for placeholders

This keeps HAL simple (wire protocol + dialect abstraction) and EMS owns all query building.

## Related
- Commit `fe1ab91`: Initial refactor moving database primitives to HAL
- Ring 5 observers already use dialect correctly
