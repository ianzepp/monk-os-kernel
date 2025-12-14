# Dialect Migration Plan

## Executive Summary

The `wip/dec-9-14-work` branch (51 commits) plus `wip/debug-logging` (4 more) accomplishes a major architectural refactoring to support multiple database dialects (SQLite and PostgreSQL).

**Total impact**: ~92 files changed, ~3000 insertions, ~1700 deletions

## The Core Problem

### Current State (v0.7.0)
- Hard-coded SQLite assumptions in EMS observers
- Duplicate DDL observers for SQLite vs PostgreSQL
- Dialect-specific SQL scattered throughout
- Monolithic boot sequence

### Target State
- DatabaseDialect abstraction (SQLite/PostgreSQL implementations)
- Unified Ring 5/6 observers using dialect for SQL generation
- JSON model definitions (dialect-agnostic)
- Phased boot: `init()` prepares subsystems, `boot()` activates services

## Suggested Phases

### Phase 1: Foundation (Low Risk)
**Already done in v0.6.0/v0.7.0**
- Apps: displayd, crond, timerd, agentd
- Coreutils: env, bc, test, kill, ps, timeout, xargs, base64, etc.
- AI refactoring and wake cycle
- Model field consolidation (indexed)

### Phase 2: Boot Refactoring (Medium Risk)
**Commits**: `b02d4b9` and dependencies

Split OS/Kernel boot into `init()` and `boot()` phases:
- `init()`: Initialize subsystems, VFS/EMS functional
- `boot()`: Activate services, start tick broadcaster

**Breaking**: Tests must handle new lifecycle (boot() auto-calls init() for backward compat)

**Blocker**: Requires test infrastructure changes - TestOS needs updating

### Phase 3: Schema Extraction (High Risk)
**Commits**: `5b761d7`, `61bdc21`, `2081d80`, `2a6694f`, `486aaad`

- Rename `schema.sql` to `schema.sqlite.sql`
- Extract VFS/Auth/LLM models to JSON files
- Add `EMS.importModel()` for programmatic model registration
- Remove raw SQL schema files from subsystems

**Critical Issue**: `spec/helpers/test-os.ts` references deleted `src/vfs/schema.sql`

**Fix Required**: Update TestOS to load models via `importModel()` or correct schema path

### Phase 4: Dialect Abstraction (Critical - The Core Work)
**Commits**: `10d436a`, `8b39878`, `0dd5f22`, `cd98a4b`, `84c4ac1`, `8171365`

DatabaseDialect interface with:
- `placeholder(n)` / `placeholders(count)` for SQL parameters (? vs $1)
- `mapType()` for field type to SQL type
- `mapValue()` / `unmapValue()` for type conversion
- `createTable()` / `addColumn()` for DDL
- `beginTransaction()` for transaction syntax

Ring 5/6 observers refactored to use dialect abstraction.

### Phase 5: Polish & Debug (Low Risk)
**Commits**: `b3f1352`, `b2fa2ec`, `90b23bc`, `99ed5ec`

- Fix `default_value` in model JSON files
- Fix boolean type validation
- Add `DEBUG=` environment variable logging
- Debug syscalls and userspace logging

## Known Issues Requiring Fixes

### Issue 1: tsconfig.json Rename
**Problem**: Commit `7fa70ab` renamed `tsconfig.json` to `tsconfig.src.json`, breaking Bun's path alias resolution.

**Fix**: Either:
1. Keep `tsconfig.json` at root (symlink or copy)
2. Add `bunfig.toml` with path aliases
3. Ensure test runner uses correct tsconfig

### Issue 2: TestOS Schema Path
**Problem**: `spec/helpers/test-os.ts:27` references `src/vfs/schema.sql` which is deleted in Phase 3.

**Fix**: Update `loadVfsSchema()` to either:
1. Use `schema.sqlite.sql` path
2. Load VFS models via `importModel()` like other subsystems

### Issue 3: PostgreSQL Default
**Problem**: Commit `45b4590` changes default storage to `postgres://localhost/monk_os`

**Recommendation**: Keep SQLite as default until Phase 5; add `--postgres` flag

## Dependency Graph

```
Phase 1 (v0.7.0) - DONE
    |
Phase 2 (Boot Split)
    |
    +-- Requires: TestOS lifecycle updates
    |
Phase 3 (Schema Extraction)
    |
    +-- Requires: Phase 2 for init()/boot() pattern
    +-- Requires: Fix TestOS schema path
    |
Phase 4 (Dialect Abstraction)
    |
    +-- Requires: Phase 3 for JSON models
    +-- Requires: All Ring 5/6 observer updates
    |
Phase 5 (Polish)
    |
    +-- Requires: Phase 4 complete
```

## Risk Assessment

| Phase | Risk | Confidence | Rollback Cost |
|-------|------|------------|---------------|
| 1 | Low | Very High | Trivial |
| 2 | Medium | High | Minor |
| 3 | High | Medium | Moderate |
| 4 | **Critical** | High | Major |
| 5 | Low | Very High | Trivial |

## Recommended Approach

**Option A: Fix Forward**
1. Checkout `wip/dec-9-14-work`
2. Fix tsconfig issue (restore `tsconfig.json` or add bunfig)
3. Fix TestOS schema path
4. Run tests, fix any remaining issues
5. Fast-forward main once stable

**Option B: Phased Cherry-Pick**
1. Cherry-pick Phase 2 commits
2. Fix test failures
3. Release as v0.8.0
4. Repeat for Phase 3, 4, 5

**Recommendation**: Option A is likely faster since the commits are interdependent. The fixes are well-understood (tsconfig + TestOS path).

## Success Criteria

- [ ] All 2052+ tests pass
- [ ] Boot works with SQLite (default)
- [ ] Boot works with PostgreSQL (optional)
- [ ] `DEBUG=1` shows initialization sequence
- [ ] No duplicate dialect-specific code
