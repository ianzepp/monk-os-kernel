# Monk OS AI Layer

> **Status**: Planning
> **Depends on**: HAL, EMS, Shell/Coreutils

This document captures the architecture for AI integration with Monk OS.

---

## Core Concepts

### LLM vs AI

| Concept | Role | Layer |
|---------|------|-------|
| **LLM** | Pattern matching. Prompt in, text out. Stateless inference. | HAL |
| **AI** | Tool-using intelligence. Plans, executes, remembers. | Kernel subsystem |

The LLM is infrastructure (like a database). The AI is the coordinator that uses the LLM alongside other OS capabilities.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Userspace                                                   │
│   /bin/shell   /bin/cat   /bin/grep   /bin/awk   ...       │
│   (AI uses these as tools for text/data processing)        │
└─────────────────────────────────────────────────────────────┘
                          │ syscalls
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Kernel                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Auth   │  │    AI    │  │   VFS    │  │   EMS    │   │
│  │  worker  │  │  worker  │  │          │  │          │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                     │                                       │
│              ┌──────┴──────┐                               │
│              │  ai:* calls │                               │
│              │  memory mgmt│                               │
│              │  tool exec  │                               │
│              └──────┬──────┘                               │
│                     ▼                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ EMS (ai.stm, ai.ltm, ai.procedural, ai.embedding)   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ HAL                                                         │
│   hal.llm   hal.file   hal.ems   hal.network   ...         │
└─────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

**HAL (hal.llm)**
- Dumb inference pipe
- Provider abstraction (Anthropic, OpenAI, Ollama, local)
- API key management, rate limiting, retries
- Prompt in → text/embeddings out

**AI Worker (kernel subsystem)**
- Coordinates tool use, memory, and inference
- Spawns shell/coreutils for text processing
- Manages memory (STM, LTM, procedural)
- Handles ai:* syscalls
- Similar pattern to Auth worker

**Userspace (shell + coreutils)**
- `/bin/shell` - command interpreter
- `/bin/cat`, `/bin/grep`, `/bin/awk`, etc. - text processing tools
- AI worker spawns these as needed

---

## Syscalls (ai:*)

| Syscall | Description |
|---------|-------------|
| `ai:complete` | One-shot inference (prompt → response) |
| `ai:chat` | Conversational with STM context |
| `ai:embed` | Generate embeddings for text |
| `ai:exec` | "Do this" - AI plans and executes tools |
| `ai:remember` | Store to LTM explicitly |
| `ai:recall` | Query memory (STM, LTM, procedural) |

### Examples

```typescript
// Simple completion
const response = await syscall('ai:complete', {
  prompt: 'Summarize this error log',
  context: logContent
});

// Conversational (manages STM automatically)
const response = await syscall('ai:chat', {
  session: 'user-123',
  message: 'How many account records changed today?'
});

// AI executes tools autonomously
const result = await syscall('ai:exec', {
  task: 'Find all files larger than 10MB and list them by size',
  cwd: '/var/log'
});

// Generate embeddings for semantic search
const vector = await syscall('ai:embed', {
  text: 'account billing invoice payment'
});

// Explicit memory operations
await syscall('ai:remember', {
  content: 'User prefers terse responses',
  scope: 'user-123'
});

const memories = await syscall('ai:recall', {
  query: 'user preferences',
  scope: 'user-123'
});
```

---

## Memory Model

Memory is stored as EMS entities. The AI worker queries and manages these.

### Memory Types

| Model | Purpose | Retention |
|-------|---------|-----------|
| `ai.stm` | Short-term memory. Conversation turns, recent context. | Session or hours |
| `ai.ltm` | Long-term memory. Consolidated knowledge, facts. | Persistent |
| `ai.procedural` | Tool patterns that worked. "This query format succeeded." | Persistent |
| `ai.embedding` | Vector index for semantic similarity search. | Persistent |

### Entity Schemas

```typescript
// Short-term memory (conversation turns)
interface STM {
  model: 'ai.stm';
  session: string;      // session identifier
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

// Long-term memory (consolidated knowledge)
interface LTM {
  model: 'ai.ltm';
  scope: string;        // user, org, or global
  topic: string;        // categorization
  content: string;
  ts: number;
}

// Procedural memory (successful patterns)
interface Procedural {
  model: 'ai.procedural';
  trigger: string;      // what kind of request
  pattern: string;      // what worked
  success_count: number;
  ts: number;
}

// Embedding index
interface Embedding {
  model: 'ai.embedding';
  source_model: string; // which entity this embeds
  source_id: string;
  vector: number[];
  ts: number;
}
```

### Memory Consolidation ("Sleep")

STM accumulates during active use. Consolidation runs during idle periods (or scheduled):

```typescript
// Consolidation process
async function consolidate() {
  // Gather recent STM
  const recent = await ems.query('ai.stm', { age: '<24h' });

  // Extract key information via LLM
  const consolidated = await hal.llm.complete({
    prompt: 'Extract key facts, preferences, and patterns worth remembering long-term',
    context: recent
  });

  // Store to LTM
  await ems.insert('ai.ltm', {
    scope: 'user-123',
    topic: 'daily-summary',
    content: consolidated,
    ts: Date.now()
  });

  // Prune old STM
  await ems.delete('ai.stm', { age: '>48h' });
}
```

Like human sleep: experiences accumulate during the day, important patterns consolidate overnight, noise is forgotten.

---

## Tool Execution

The AI worker uses shell and coreutils as tools. This avoids reimplementing text processing.

### Flow

```
User: "Find log files with errors and count them"
                    │
                    ▼
AI worker:
  1. Query STM/LTM for context
  2. Call hal.llm to plan: "grep -l 'error' /var/log/*.log | wc -l"
  3. Spawn /bin/shell with command
  4. Capture output
  5. Call hal.llm to format response
  6. Store interaction in STM
  7. Return to user
```

### Why Shell/Coreutils?

- Already handles edge cases (quoting, escaping, pipes)
- Composable via pipes
- AI can generate shell commands (well-documented in training data)
- No need to reimplement grep, awk, sed, etc.

---

## HAL LLM Interface

`hal.llm` is the dumb inference layer. Provider-agnostic.

### Operations

```typescript
interface HalLLM {
  // Text completion
  complete(opts: {
    prompt: string;
    context?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<string>;

  // Streaming completion
  stream(opts: {
    prompt: string;
    context?: string;
  }): AsyncIterator<string>;

  // Embeddings
  embed(opts: {
    text: string;
    model?: string;
  }): Promise<number[]>;
}
```

### Provider Configuration

```typescript
// Config in /etc/ai.conf or similar
{
  provider: 'anthropic' | 'openai' | 'ollama' | 'local',
  endpoint: 'https://api.anthropic.com' | 'http://localhost:11434',
  api_key: '...',
  default_model: 'claude-3-sonnet',
  embedding_model: 'text-embedding-3-small'
}
```

HAL handles:
- Provider-specific API formats
- Authentication
- Rate limiting and retries
- Error normalization

---

## Context Window Management

LLMs have finite context windows. The AI worker must select what fits.

```
Available:
  - STM: 500 turns (too much)
  - LTM: 1000 entries (too much)
  - Current request context

Must fit in:
  - Model context window (e.g., 100k tokens)

Strategy:
  1. Current request (always included)
  2. Recent STM (last N turns)
  3. Relevant LTM (semantic search via embeddings)
  4. Relevant procedural memory
  5. Truncate/summarize if still too large
```

---

## Implementation Plan

### Phase 1: HAL LLM

1. Add `hal.llm` device with complete/embed operations
2. Support at least one provider (Anthropic or Ollama)
3. Provider config in /etc/ai.conf

### Phase 2: AI Worker

1. Create AI worker (kernel subsystem, like Auth)
2. Implement `ai:complete` and `ai:chat` syscalls
3. Basic STM storage in EMS

### Phase 3: Shell Integration

1. Reintroduce `/bin/shell` to OS userspace
2. Add basic coreutils (`cat`, `grep`, `head`, `tail`, `wc`)
3. AI worker can spawn tools

### Phase 4: Memory

1. LTM storage and retrieval
2. Procedural memory for tool patterns
3. Embedding support in EMS
4. Consolidation process

### Phase 5: Advanced

1. `ai:exec` for autonomous tool use
2. Streaming responses
3. Multi-provider support
4. Context window optimization

---

## Open Questions

### 1. Embedding Storage

Should embeddings live in EMS or a dedicated vector store?

| Option | Pros | Cons |
|--------|------|------|
| EMS | Unified storage, existing query language | May need vector index extension |
| Dedicated | Optimized for vector ops | Another system to maintain |

### 2. Permission Model

How does AI worker permission work?

| Option | Notes |
|--------|-------|
| Inherits caller | AI has same permissions as requesting user |
| Dedicated AI user | AI runs as its own principal |
| Escalation | AI can request elevated permissions (with approval) |

### 3. Tool Sandboxing

How much can AI-spawned tools do?

| Option | Notes |
|--------|-------|
| Full access | AI tools have caller's permissions |
| Restricted | AI tools run in sandbox |
| Approval | Destructive operations require confirmation |

---

## References

- `src/kernel/subsys/auth/` - Auth worker pattern to follow
- `src/hal/` - HAL device implementations
- `src/ems/` - Entity storage
- `rom/lib/shell/` - Existing shell implementation (to reintroduce)
