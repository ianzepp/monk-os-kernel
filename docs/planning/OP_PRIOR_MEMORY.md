# OP_PRIOR_MEMORY: Prior Short-Term Memory

## Overview

Add file-based memory to Prior, enabling context persistence across tasks without
sending full conversation history to the LLM on every request.

## Problem

Traditional LLM conversations send entire history with every message:
- Expensive (token costs scale with history)
- Slow (latency increases with context size)
- Noisy (irrelevant context accumulates)

## Solution

File-based memory with delegated distillation:
- Prior writes to memory files in VFS
- Context is distilled (summarized/filtered) periodically
- Only relevant context sent to LLM
- Distillation delegated to monk processes (not built-in)

## Architecture

```
Prior
  │
  ├── writes raw exchanges ──► /var/prior/session.log
  │
  ├── reads distilled context ◄── /var/prior/context.txt
  │
  └── delegates distillation ──► monk process
                                    │
                                    ├── reads session.log
                                    ├── extracts key facts
                                    └── writes context.txt
```

## File Structure

```
/var/prior/
  identity.txt     # Self-discovery result (written once on boot)
  session.log      # Raw task history (append-only)
  context.txt      # Distilled working context (rewritten by distiller)
  facts.json       # Key facts as structured data (optional)
```

### identity.txt
Written on first tick after self-discovery. Contains Prior's understanding
of its environment. Read at startup, included in system context.

### session.log
Append-only log of task exchanges:
```
[2024-01-15T10:30:00Z] TASK: What commands are available?
[2024-01-15T10:30:02Z] RESULT: The following commands are in /bin/: cat, ls, grep...
[2024-01-15T10:31:00Z] TASK: Create a file called test.txt
[2024-01-15T10:31:01Z] RESULT: File created at /tmp/test.txt
```

### context.txt
Distilled summary of session, kept small:
```
Recent activity:
- User explored available commands
- Created test file at /tmp/test.txt

Open threads:
- None

Key facts learned:
- User is testing file operations
```

## Implementation

### Phase 1: Memory Files

1. Create `/var/prior/` directory on Prior startup
2. Write `identity.txt` after self-discovery (tick 1)
3. Append to `session.log` after each task
4. Read `context.txt` (if exists) and include in LLM context

### Phase 2: Distillation Delegation

1. On tick N (e.g., every 30 ticks), check session.log size
2. If above threshold, spawn monk process:
   ```typescript
   await spawn('/bin/monk', {
       args: ['--task', 'Distill session log to key facts and context'],
       env: {
           INPUT: '/var/prior/session.log',
           OUTPUT: '/var/prior/context.txt',
       }
   });
   ```
3. Monk reads input, processes via LLM, writes output
4. Prior reads distilled context on next task

### Context Assembly

When executing a task, Prior builds context:
```typescript
const context = {
    identity: await readFile('/var/prior/identity.txt'),
    memory: await readFile('/var/prior/context.txt'),  // distilled
    // NOT full session.log
};

const response = await call('llm:complete', model, prompt, {
    system: systemPrompt,
    context,
});
```

## Delegated Distillation

Key insight: Prior doesn't need built-in distillation logic. It delegates
to monk processes, which are themselves LLM-powered agents.

Benefits:
- Separation of concerns (Prior orchestrates, monks execute)
- Flexible (can use different models for distillation)
- Async (distillation runs in background)
- Extensible (monks can do other memory tasks: archive, search, etc.)

Distillation prompt for monk:
```
Read the session log at {INPUT}.
Extract:
- Key decisions made
- Important facts learned
- Open threads / unfinished tasks
- User preferences observed

Write a concise summary (under 500 words) to {OUTPUT}.
Discard: greetings, resolved issues, redundant information.
```

## Future: Long-Term Memory

Phase 3+ could add:
- `/var/prior/archive/` for old sessions
- EMS-backed facts database
- Embedding-based retrieval for relevant context
- Cross-session learning

## Files to Modify

| File | Changes |
|------|---------|
| `rom/bin/prior.ts` | Create memory dir, write identity, log sessions, read context |
| `rom/etc/prior/system.txt` | Update to mention memory capabilities |
| (new) `rom/bin/monk.ts` | Generic monk process for delegated tasks |

## Status

- [x] Design document
- [x] Memory file structure (`/var/prior/`)
- [x] Identity persistence (tick 1, saved to identity.txt)
- [x] Session logging (appendFile to session.log)
- [x] Context reading in executeTask (identity + memoryContext)
- [ ] Distillation delegation (Phase 2)
