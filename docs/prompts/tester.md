# Test & Typecheck Fixer - Parallel Agent Prompt

Use this prompt to spawn parallel agents that fix spec/ and perf/ typecheck and test failures.

---

## Overview

When refactoring core infrastructure (HAL, VFS, EMS, Kernel), tests often fall out of sync. This prompt guides spawning multiple agents to fix failures in parallel.

**Typical failure categories:**
1. **Type mismatches** - Interfaces changed, tests use old signatures
2. **Missing properties** - New required fields on mocks/interfaces
3. **Stale imports** - Modules renamed or removed
4. **Schema changes** - Database/entity fields added/removed
5. **Initialization changes** - Setup requirements changed

---

## Step 1: Gather Failure Data

Run all checks and capture output:

```bash
# Create unique run ID for this session (use in all commands)
RUN_ID=$(date +%Y%m%d-%H%M%S)-$$

# Typecheck (save output for analysis)
bun run typecheck 2>&1 | head -100
bun run typecheck:spec 2>&1 | tee /tmp/spec-typecheck-${RUN_ID}.txt
bun run typecheck:perf 2>&1 | tee /tmp/perf-typecheck-${RUN_ID}.txt

# Tests (save output for analysis)
bun run test 2>&1 | tee /tmp/test-output-${RUN_ID}.txt
bun run perf 2>&1 | tee /tmp/perf-output-${RUN_ID}.txt

# Pass RUN_ID to agents so they can use unique temp files
echo "Run ID: ${RUN_ID}"
```

---

## Step 2: Categorize Failures

Group failures by root cause, not by file. Common patterns:

| Category | Symptom | Fix Strategy |
|----------|---------|--------------|
| **HAL Mock Incomplete** | "missing properties: compression, file, init" | Update createMockHAL() helper |
| **Type Signature Changed** | "Expected N arguments, got M" | Update call sites to match new signature |
| **Interface Property Removed** | "'name' does not exist in type 'EntityInput'" | Remove property from test data |
| **Interface Property Added** | "missing the following properties" | Add required properties to mocks |
| **Stale Imports** | "Cannot find module '@src/lib/...'" | Update import paths |
| **Possibly Undefined** | "Object is possibly 'undefined'" | Add null checks or use `!` assertion |
| **Unused Imports** | "is declared but its value is never read" | Remove unused import |
| **Init/Setup Changed** | "Folder model not registered" | Update test setup to register models |
| **Schema Mismatch** | "table X has no column named Y" | Update entity creation to match schema |

---

## Step 3: Identify Shared Fixes

Before spawning agents, identify fixes that affect multiple files:

**High-impact shared fixes (do these FIRST, sequentially):**
1. `spec/helpers/test-mocks.ts` - If mock helpers are broken, fix first
2. HAL interface additions - Update mock factories
3. Shared test utilities - Fix base classes/helpers

**Then parallelize per-file fixes.**

---

## Step 4: Agent Assignment Strategy

### For Typecheck Fixes

Group by error type, not file location:

```
Agent 1: HAL mock updates
  - spec/helpers/test-mocks.ts (if exists)
  - All files with "missing properties from type 'HAL'"

Agent 2: Unused imports & variables
  - All files with "declared but its value is never read"

Agent 3: Possibly undefined fixes
  - All files with "possibly 'undefined'" or "possibly 'null'"

Agent 4: Type signature updates
  - All files with "Expected N arguments" or "does not exist in type"
```

### For Test Runtime Fixes

Group by failure pattern:

```
Agent 1: VFS/Model registration
  - All tests failing with "model not registered"
  - Focus: test setup/beforeEach blocks

Agent 2: Entity/Schema fixes
  - All tests failing with "no column named X"
  - Focus: entity creation, field names

Agent 3: Initialization order
  - All tests failing with "Entity not found"
  - Focus: async setup, await ordering
```

---

## Step 5: Agent Prompt Template

Use this template for each agent:

```
**Context:** We're fixing test failures after a refactor. The src/ code is correct and passes typecheck. Tests need updating to match.

**Reference files to read first:**
1. Read the CURRENT interface/type definitions from src/ that the tests use
2. Read any existing working test file as an example pattern

**Your files to fix:**
1. /absolute/path/to/file1.test.ts
2. /absolute/path/to/file2.test.ts
[list all files for this agent]

**Error category you're fixing:** [HAL mocks | unused imports | undefined checks | etc.]

**Specific errors from typecheck:**
```
[paste relevant error messages here]
```

**Your agent ID:** [AGENT_1 | AGENT_2 | etc. - unique per agent]

**Fix process:**
1. Read each file
2. Read the src/ types/interfaces the test imports
3. Update the test to match current interfaces
4. Write fixed version to {filename}.{AGENT_ID}.tmp.ts (unique per agent to avoid conflicts)
5. Run: bun run typecheck:spec (or typecheck:perf)
6. If passes, move .tmp.ts over original and delete temp file
7. If fails, iterate on the temp file
8. Clean up any remaining .tmp.ts files when done

**Rules:**
- Do NOT change src/ files - only spec/ or perf/
- Preserve test intent - fix types, not test logic
- If a test is fundamentally broken (tests removed functionality), skip and note it
- Add `!` assertions sparingly - prefer proper null checks

**Report back:**
- List of files fixed
- Any files skipped and why
- Typecheck status after fixes
- Confirm all .{AGENT_ID}.tmp.ts files were cleaned up
```

---

## Step 6: Launch Parallel Agents

### Maximizing Parallelism

**Goal:** Run as many agents simultaneously as possible. Sequential dependencies defeat the purpose.

**Decision tree:**
```
For each file with errors:
  └─ Does it depend on another file being fixed first?
       ├─ YES (e.g., imports from test-mocks.ts) → Same phase as dependency, or later phase
       └─ NO → Phase 1 (immediate parallel execution)
```

**Ideal structure:**
- **Phase 0 (sequential):** Only if there's a shared helper that multiple agents need fixed first (rare)
- **Phase 1 (parallel):** ALL other agents run simultaneously

**Anti-pattern - don't do this:**
```
Agent 1 → Agent 2 → Agent 3 → Agent 4   # This is just sequential with extra steps!
```

**Correct pattern:**
```
[Agent 1] ─┐
[Agent 2] ─┼─→ All complete → Verify
[Agent 3] ─┤
[Agent 4] ─┘
```

Or if there's a true shared dependency:
```
Phase 0: [Agent 1 - shared infra]
              ↓
Phase 1: [Agent 2] ─┐
         [Agent 3] ─┼─→ All complete → Verify
         [Agent 4] ─┘
```

### Example (for illustration only - adapt to your actual failures)

```typescript
// ============================================================================
// PHASE 0: Sequential (only if shared dependency exists)
// ============================================================================
// In this example, test-mocks.ts is imported by other test files, so fix first.
// If no shared dependencies exist, skip Phase 0 entirely and run all in Phase 1.

Task({
  description: "Fix test mocks and helpers",
  prompt: `
    **Agent ID:** AGENT_1
    **Context:** Fixing test infrastructure after HAL/VFS refactor.

    **Read first:**
    - src/hal/index.ts (current HAL interface)
    - src/vfs/vfs.ts (current VFS class)

    **Fix these files (you own these exclusively):**
    - spec/helpers/test-mocks.ts

    **Errors:**
    - Cannot find module '@src/lib/system-context-types.js'
    - Cannot find module '@src/lib/model.js'
    - HAL missing: compression, file, init

    **Task:** Update imports, add missing HAL properties to mock factory.
    **Temp files:** Use .AGENT_1.tmp.ts suffix for any intermediate files.
    **Verify with:** bun run typecheck:spec
  `
})

// ============================================================================
// PHASE 1: Parallel (launch ALL of these simultaneously in a single message)
// ============================================================================
// These agents have NO dependencies on each other. Launch them together.

Task({
  description: "Fix HAL mock usage",
  prompt: `
    **Agent ID:** AGENT_2
    **Context:** HAL interface added compression, file, init properties.

    **Read first:**
    - src/hal/index.ts (HAL interface)
    - spec/helpers/test-mocks.ts (read-only reference)

    **Fix these files (you own these exclusively):**
    - spec/kernel/boot.test.ts
    - spec/kernel/shell.test.ts
    - spec/vfs/models.test.ts
    - spec/vfs/vfs.test.ts
    - perf/kernel/process-spawn.perf.ts
    - perf/vfs/storage.perf.ts

    **Error pattern:** "missing properties from type 'HAL': compression, file, init"

    **Task:** Update mock HAL objects to include all required properties.
    **Temp files:** Use .AGENT_2.tmp.ts suffix for any intermediate files.
    **Verify with:** bun run typecheck:spec && bun run typecheck:perf
  `
}),

Task({
  description: "Fix unused imports and null checks",
  prompt: `
    **Agent ID:** AGENT_3
    **Context:** Cleaning up TypeScript strict mode errors.

    **Fix these files (you own these exclusively):**
    [list all files with TS6133 or TS2532 errors - ensure no overlap with other agents]

    **Error patterns:**
    - TS6133: "X is declared but its value is never read"
    - TS2532: "Object is possibly 'undefined'"
    - TS18048: "X is possibly 'undefined'"

    **Task:**
    - Remove unused imports
    - Add appropriate null checks or assertions
    **Temp files:** Use .AGENT_3.tmp.ts suffix for any intermediate files.
    **Verify with:** bun run typecheck:spec
  `
}),

Task({
  description: "Fix EntityCache type usage",
  prompt: `
    **Agent ID:** AGENT_4
    **Context:** EntityInput/EntityUpdate interfaces changed.

    **Read first:**
    - src/ems/entity-cache.ts (EntityInput, EntityUpdate types)

    **Fix these files (you own these exclusively):**
    - perf/ems/entity-cache.perf.ts

    **Error pattern:** "'name' does not exist in type 'EntityInput'"

    **Task:** Update entity creation to use correct field names.
    **Temp files:** Use .AGENT_4.tmp.ts suffix for any intermediate files.
    **Verify with:** bun run typecheck:perf
  `
})
// Note: Agents 2, 3, 4 are launched in a SINGLE message with multiple Task calls
```

---

## Step 7: Verification & Iteration

After all agents complete:

```bash
# Clean up any leftover temp files (should be none if agents cleaned up)
find spec/ perf/ -name "*.tmp.ts" -delete

# Full typecheck
bun run typecheck:spec
bun run typecheck:perf

# If clean, run tests
bun run test
bun run perf

# Check what changed
git diff --stat spec/ perf/

# Verify no temp files were accidentally committed
git status | grep -E "\.tmp\.ts$" && echo "ERROR: Temp files detected!" || echo "OK: No temp files"

# Commit if passing
git add spec/ perf/
git commit -m "fix(tests): Update tests after EMS/VFS refactor"
```

**If failures remain:**
1. Categorize remaining failures
2. Spawn focused agents for specific issues
3. Repeat until clean

---

## Parallel Safety Rules

**File ownership:** Each agent is assigned specific files. Never modify files not in your assignment.

**Temp file naming:** Always include agent ID in temp files:
```
spec/kernel/boot.test.AGENT_2.tmp.ts   # Good - unique
spec/kernel/boot.test.fixed.ts          # Bad - could conflict
```

**Shared files:** If multiple agents need to read a shared file (like test-mocks.ts):
- Only ONE agent writes to it
- Other agents read it but don't modify
- Or: fix shared files in a sequential step BEFORE parallel agents

**Verification commands:** Safe to run in parallel (read-only):
```bash
bun run typecheck:spec  # OK - just reads files
bun run test            # OK - tests are isolated
```

**Git operations:** NOT safe in parallel:
```bash
git add/commit          # Must be sequential, after all agents complete
```

---

## Common Pitfalls

### Don't Do This

```typescript
// BAD: Changing src/ to match broken tests
// The src/ is correct - tests must adapt

// BAD: Disabling tests instead of fixing
it.skip('broken test', ...); // Only if truly obsolete

// BAD: Casting away type errors
const hal = mockHal as unknown as HAL; // Hides real issues
```

### Do This

```typescript
// GOOD: Update mock to match interface
const mockHal: HAL = {
  ...existingMock,
  compression: createMockCompression(),
  file: createMockFile(),
  init: async () => {},
};

// GOOD: Add proper null checks
const call = mockDb.calls[0];
if (!call) throw new Error('Expected call');
expect(call.sql).toContain('INSERT');

// GOOD: Remove truly unused imports
// Before: import { A, B, C } from './types';
// After:  import { A, C } from './types'; // B was unused
```

---

## Quick Reference: Error Code to Fix

| Error Code | Meaning | Typical Fix |
|------------|---------|-------------|
| TS2307 | Cannot find module | Update import path |
| TS2322 | Type not assignable | Update value to match type |
| TS2339 | Property doesn't exist | Remove property or update type |
| TS2345 | Argument type mismatch | Fix argument type |
| TS2532 | Object possibly undefined | Add null check |
| TS2554 | Wrong argument count | Add/remove arguments |
| TS6133 | Declared but never read | Remove unused declaration |
| TS18048 | Value possibly undefined | Add null check |

---

## Timing Expectations

| Scope | Sequential | Parallel (4 agents) |
|-------|------------|---------------------|
| 10 files, minor fixes | ~15 min | ~5 min |
| 20 files, type updates | ~30 min | ~10 min |
| 50+ files, major refactor | ~90 min | ~25 min |

---

## Example: Recent EMS/VFS Refactor

**Failure summary:**
- typecheck:spec: 90 errors
- typecheck:perf: 50 errors
- test: 105 failures / 1200 pass
- perf: 43 failures / 44 pass

**Agent split (5 agents):**

| Agent | Focus | Files | Errors |
|-------|-------|-------|--------|
| 1 | test-mocks.ts + stale imports | 1 | 5 |
| 2 | HAL mock properties | 6 | 15 |
| 3 | Unused imports/variables | 15 | 40 |
| 4 | Null/undefined checks | 12 | 35 |
| 5 | EntityInput/perf types | 4 | 25 |

**Execution:**
1. Run Agent 1 first (shared dependency) - uses AGENT_1 temp file suffix
2. Run Agents 2-5 in parallel - each uses AGENT_N temp file suffix
3. Clean up: `find spec/ perf/ -name "*.tmp.ts" -delete`
4. Verify, iterate on remaining failures
