# Collaborative Planning Mode

Use this approach instead of Claude's built-in plan mode for feature planning and design work.

---

## Why Not Built-in Plan Mode?

| Built-in Plan Mode | This Approach |
|--------------------|---------------|
| Can't write files | Plans live in `docs/` as markdown |
| Creates giant task lists autonomously | Iterative conversation with user |
| Plans vanish after session/compact | Plans persist in git, survive across sessions |
| No progress tracking | Git log shows implementation history |
| All-or-nothing approval | Incremental refinement and partial approval |

---

## The Philosophy

**Plans are living documents, not task lists.**

1. **Collaborative**: User and agent iterate on the design together
2. **Persistent**: Written to `docs/planning/` so they survive session boundaries
3. **Incremental**: Start rough, refine through discussion
4. **Tracked**: Git log shows what was planned vs. what was built
5. **Movable**: Files move through `planning/` → `partial/` → `implemented/`

---

## Directory Structure

```
docs/
├── planning/       # Future work - not started
├── partial/        # In progress - partially implemented
├── implemented/    # Complete - working in codebase
├── bugs/           # Known issues to fix
└── wont-implement/ # Explicitly rejected (with rationale)
```

**File lifecycle:**
1. Create in `planning/` during design
2. Move to `partial/` when implementation begins
3. Move to `implemented/` when complete
4. Or move to `wont-implement/` if rejected (keep the rationale!)

---

## Document Structure

Use this template for planning documents:

```markdown
# Feature Name

> **Status**: Planning | Partial | Implemented
> **Complexity**: Low | Medium | High
> **Dependencies**: List of prerequisite features or docs

One paragraph explaining what this feature is and why it matters.

---

## Overview

2-3 paragraphs of context. What problem does this solve?
Why now? What's the scope?

---

## Architecture

ASCII diagram showing components and data flow:

┌─────────────┐     ┌─────────────┐
│ Component A │────▶│ Component B │
└─────────────┘     └─────────────┘

---

## Design

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| X vs Y | X | Because... |

### Types/Interfaces

```typescript
interface NewThing {
    // ...
}
```

### Syscalls/APIs

| Name | Signature | Purpose |
|------|-----------|---------|
| ... | ... | ... |

---

## Implementation Plan

### Phase 1: Foundation
- [ ] Task 1
- [ ] Task 2

### Phase 2: Core Features
- [ ] Task 3
- [ ] Task 4

### Phase 3: Polish
- [ ] Task 5

---

## Open Questions

| Question | Options | Notes |
|----------|---------|-------|
| Unresolved decision? | A, B, C | Tradeoffs... |

---

## References

- Related doc 1
- Related doc 2
```

---

## How to Use This

### Starting a New Feature

1. **User describes the feature** (high level)
2. **Agent creates `docs/planning/FEATURE_NAME.md`** with initial structure
3. **Iterate together**: User asks questions, agent refines
4. **Lock down decisions**: Update "Key Decisions" table
5. **Agree on phases**: Break into implementable chunks

### During Implementation

1. **Move to `docs/partial/`** when starting
2. **Check off tasks** as they're completed
3. **Update doc** if design changes during implementation
4. **Move to `docs/implemented/`** when done

### Across Sessions

New session? Read the planning doc to understand:
- What was decided
- What's implemented (check git log)
- What's left (unchecked tasks)
- Open questions still needing answers

---

## Anti-Patterns to Avoid

### Don't: Create Giant Task Lists

```markdown
<!-- BAD: 50 items with no context -->
- [ ] Create file A
- [ ] Create file B
- [ ] Add import to C
- [ ] Update D
... (50 more)
```

### Do: Create Meaningful Phases

```markdown
<!-- GOOD: Logical chunks with context -->
### Phase 1: Core Types
Define the interfaces and types. No implementation yet.
- [ ] Create types.ts with Message, Response
- [ ] Add to index.ts exports

### Phase 2: Basic Implementation
Get the happy path working.
- [ ] Implement open()
- [ ] Implement close()
```

### Don't: Plan Everything Before Starting

```markdown
<!-- BAD: Trying to specify every detail upfront -->
## Implementation
1. In file A, line 47, add...
2. In file B, change function X to...
```

### Do: Leave Room for Discovery

```markdown
<!-- GOOD: Direction without over-specification -->
## Implementation Plan

### Phase 1: Prototype
Get basic functionality working. Details will emerge.
- [ ] Core mechanism
- [ ] Happy path test

### Phase 2: Harden
Based on Phase 1 learnings:
- [ ] Error handling
- [ ] Edge cases
```

---

## Signals to Watch For

**User wants more detail:**
- "How would X work?"
- "What about Y case?"
- "Walk me through Z"

→ Add a section to the doc addressing it

**User wants to start:**
- "Let's do Phase 1"
- "Start with X"
- "Implement the basics"

→ Move doc to `partial/`, begin implementation

**User disagrees:**
- "I don't like X approach"
- "What about doing Y instead?"

→ Update the doc, don't argue. Document the new direction.

**User is done planning:**
- "Looks good"
- "Let's build it"
- Silence after reviewing doc

→ Confirm, then start implementation

---

## Integration with Parallel Agents

For large implementations, combine with `parallel-agents.md`:

1. **Plan in `docs/planning/`** - Design the feature
2. **Break into files** - Identify which files need changes
3. **Spawn parallel agents** - Each agent gets a subset of files
4. **Track in doc** - Update checkboxes as agents complete
5. **Move to `implemented/`** - When all phases done

---

## Example: Real Planning Session

**User**: "I want to add a timer port for scheduled callbacks"

**Agent**: Creates `docs/planning/OS_TIMER_PORT.md`:

```markdown
# Timer Port

> **Status**: Planning
> **Complexity**: Medium
> **Dependencies**: Port infrastructure (implemented)

Scheduled callback delivery via the port system.

## Overview

Timer ports allow processes to receive messages at scheduled times...

## Open Questions

| Question | Options | Notes |
|----------|---------|-------|
| One-shot vs recurring? | Both | Need different syscalls? |
| Resolution? | ms, s | Affects implementation |
```

**User**: "Let's support both one-shot and recurring. Millisecond resolution."

**Agent**: Updates doc with decisions, adds implementation plan.

**User**: "Looks good, start Phase 1"

**Agent**: Moves to `docs/partial/OS_TIMER_PORT.md`, begins implementation.

---

## Summary

1. **Write plans to `docs/planning/`** - They persist
2. **Iterate with user** - Don't go off and plan alone
3. **Move files through stages** - planning → partial → implemented
4. **Keep docs updated** - They're the source of truth
5. **Use git log** - Shows what was actually built vs. planned
