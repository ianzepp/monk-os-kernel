# AI Request Tracking

## Status

**Phase 1 COMPLETE** - Core tracking implemented (2024-12)

- [x] `ai.request` schema and instrumentation
- [x] `ai.request_event` schema and instrumentation
- [ ] `ai.conversation` schema (future)
- [ ] `ai.spawn` schema (future)
- [ ] CLI query tools (future)
- [ ] Self-analysis job (future)

## Problem

Currently, Prior logs activity to stderr/UDP with no correlation between related events. When debugging or analyzing behavior, there's no way to:

- Trace a request from start to finish
- Understand which commands produced which results
- Analyze patterns in Prior's behavior over time
- Query historical requests

## Decision

Track all AI activity through EMS models rather than ephemeral logging. This provides structured, queryable history that enables debugging, analysis, and self-improvement.

## EMS Models

### ai.request (IMPLEMENTED)

Top-level request entity. Created when a task arrives, updated on completion.

**Schema:** `src/llm/schema.sql`
**Instrumentation:** `rom/bin/prior.ts` in `executeTask()`

```typescript
interface AIRequest {
    id: string;              // 4-char correlation ID (e.g., "a1b2")
    task: string;            // Original instruction text
    client_addr: string;     // Client address (e.g., "127.0.0.1:58198")
    model: string;           // LLM model used (e.g., "claude-sonnet-4")
    status: 'running' | 'ok' | 'error';
    result?: string;         // Final response or error message (truncated to 10KB)
    iterations: number;      // How many agentic loop iterations
    duration_ms?: number;    // Total request duration

    // Timestamps
    started_at: string;      // ISO timestamp
    completed_at?: string;   // ISO timestamp

    // Token usage (if available) - NOT YET POPULATED
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}
```

### ai.request_event (IMPLEMENTED)

Individual events within a request. One per command execution.

**Schema:** `src/llm/schema.sql`
**Instrumentation:** `rom/bin/prior.ts` in `executeCommand()`

```typescript
interface AIRequestEvent {
    id: string;              // Auto-generated UUID
    request_id: string;      // FK to ai.request
    iteration: number;       // Which loop iteration (1, 2, 3...)
    sequence: number;        // Order within iteration (for parallel commands)

    event_type: 'exec' | 'call' | 'spawn' | 'wait' | 'ref' | 'coalesce' | 'help';
    command: string;         // What was executed (e.g., "ls /bin")
    result: string;          // Output or error (truncated to 10KB)
    duration_ms: number;     // How long this command took

    created_at: string;      // ISO timestamp (auto-generated)
}
```

### ai.conversation (FUTURE)

Full conversation history for a request. Enables replay and analysis.

```typescript
interface AIConversation {
    id: string;              // Auto-generated UUID
    request_id: string;      // FK to ai.request
    sequence: number;        // Order in conversation (0, 1, 2...)

    role: 'user' | 'assistant' | 'exec';
    content: string;         // Message content
    tokens?: number;         // Token count for this message

    timestamp: string;       // ISO timestamp
}
```

### ai.spawn (FUTURE)

Spawned subagent tracking. Links child tasks to parent requests.

```typescript
interface AISpawn {
    id: string;              // Spawn ID (e.g., "spawn:a1b2c3d4")
    parent_request_id: string;  // FK to ai.request that spawned this
    child_request_id?: string;  // FK to ai.request for the spawned task

    task: string;            // Spawned task description
    model: string;           // Model used for spawn
    status: 'pending' | 'running' | 'ok' | 'error';
    result?: string;         // Spawn result

    started_at: string;      // ISO timestamp
    completed_at?: string;   // ISO timestamp
}
```

## Query Patterns

With this data structure, we can answer:

**Debugging:**
```
# Full trace of a request
ems:select ai.request_event where request_id = "a1b2" orderBy sequence

# Conversation history
ems:select ai.conversation where request_id = "a1b2" orderBy sequence

# All spawned subtasks
ems:select ai.spawn where parent_request_id = "a1b2"
```

**Performance analysis:**
```
# Slow requests (> 5s)
ems:select ai.request where duration_ms > 5000 orderBy -duration_ms

# Requests requiring many iterations
ems:select ai.request where iterations > 3 orderBy -iterations

# Token usage by model
ems:select ai.request groupBy model sum(total_tokens)
```

**Behavior patterns:**
```
# Most common commands
ems:select ai.request_event groupBy command count() orderBy -count limit 20

# Error rate by command type
ems:select ai.request_event where result LIKE "Error%" groupBy type count()

# Commands that often fail
ems:select ai.request_event where result LIKE "Error%" groupBy command count()
```

## Self-Improvement

Prior can analyze its own history to improve:

1. **Command failures** - "I notice `head -5` fails often, should use `head -n 5`"
2. **Iteration patterns** - "Requests about X take 3+ iterations, need better context"
3. **Token efficiency** - "Model Y uses fewer tokens for similar tasks"

These insights flow into `ai.ltm` automatically:
```typescript
await call('ems:create', 'ai.ltm', {
    content: "Use head -n N syntax, not head -N",
    category: "lessons",
    source: "self-analysis",
    evidence_count: 15  // Number of failures observed
});
```

## Tooling

### CLI Commands

```bash
# Trace a specific request
bun run trace a1b2

# Show recent requests
bun run requests --limit 10

# Stats summary
bun run stats
```

### AI CLI Enhancements

The `bun run ai` interface could show:
- Request ID when task starts
- Live event stream as commands execute
- Summary stats on completion

```
> analyze the codebase
[a1b2] Starting task...
[a1b2] !exec ls /bin -> 42 files
[a1b2] !exec wc -l /bin/*.ts -> 3847 lines
[a1b2] Completed in 2.3s (2 iterations, 1247 tokens)

The codebase contains 42 binaries totaling 3847 lines...
```

## Implementation Order

1. ~~**Add EMS models** - Define schemas in `/rom/etc/ems/models/`~~ DONE (in `src/llm/schema.sql`)
2. ~~**Instrument executeTask** - Create `ai.request` at start, update on completion~~ DONE
3. ~~**Add event logging** - Create `ai.request_event` for each command~~ DONE
4. **Add conversation logging** - Create `ai.conversation` entries
5. **Handle spawns** - Create `ai.spawn` entries, link parent/child
6. **Build query tools** - CLI commands for tracing and stats
7. **Self-analysis** - Periodic job to analyze patterns and create insights

## Migration

Existing logging (`log()` calls) can remain during transition for real-time debugging. Once EMS tracking is solid, logging can be simplified to just the request ID prefix for correlation.

## Open Questions

1. **Retention** - How long to keep request history? Forever? Rolling window?
2. **Privacy** - Should task content be stored verbatim or summarized?
3. ~~**Indexing** - Which fields need indexes for query performance?~~ RESOLVED: Added indexes for status, recent, duration, trace, and event_type
4. **Real-time** - Should events stream via pubsub for live monitoring?
5. **Token tracking** - Token usage fields exist but aren't populated yet (need to capture from LLM response)
