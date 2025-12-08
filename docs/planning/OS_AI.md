# Monk OS AI Layer

> **Status**: Planning
> **Depends on**: EMS (schema split pattern), VFS, Auth, Shell/Coreutils

This document captures the architecture for AI integration with Monk OS.

**Prerequisites completed:**
- EMS schema split (subsystems own their schemas via `ems.exec()`)
- VFS schema pattern (`src/vfs/schema.sql` as reference implementation)

---

## Core Concepts

### LLM vs AI

| Concept | Role | Layer | Analogy |
|---------|------|-------|---------|
| **LLM** | Stateless inference pipe. Prompt in, tokens out. | Kernel subsystem | `/dev/null`, network socket |
| **AI** | Stateful agent process. Plans, executes, remembers. | Userspace | Shell, daemon |

**LLM = pipe.** No identity, no state, no memory. Data flows through.

**AI = process.** Has PID, state, memory. Multiple instances can run in parallel. Can be spawned, killed, forked. Each agent owns its context and memory.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Userspace                                                   │
│                                                             │
│   AI Agents (processes with PIDs)                          │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐                   │
│   │ agent-1 │  │ agent-2 │  │ agent-3 │                   │
│   │ PID 42  │  │ PID 43  │  │ PID 44  │                   │
│   │ coder   │  │ research│  │ chat    │                   │
│   └────┬────┘  └────┬────┘  └────┬────┘                   │
│        │            │            │                         │
│   Tools: /bin/shell, /bin/cat, /bin/grep, /bin/awk, ...   │
│                                                            │
└────────────────────────┼───────────────────────────────────┘
                         │ syscalls (llm:*, vfs:*, etc.)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Kernel Subsystems                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │   Auth   │  │   LLM    │  │   VFS    │                  │
│  │          │  │  (pipe)  │  │          │                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       │             │             │                         │
│       └─────────────┴──────┬──────┘                         │
│                            ▼                               │
│              ┌─────────────────────────┐                   │
│              │          EMS            │                   │
│              │    (core: entities,     │                   │
│              │     models, fields)     │                   │
│              └─────────────────────────┘                   │
│                                                            │
│  Subsystem schemas (loaded via ems.exec() at init):        │
│    src/vfs/schema.sql  → file, folder, device, ...         │
│    src/llm/schema.sql  → llm_provider, llm_model           │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ HAL                                                         │
│   hal.file   hal.network   hal.block   ...                 │
└─────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

**LLM Subsystem (kernel)**
- Stateless inference pipe - no memory, no context
- Reads provider/model config from EMS (`llm_provider`, `llm_model`)
- Dispatches to provider-specific adapters based on `api_format`
- Applies model behavioral flags (strip markdown, etc.)
- Handles `llm:complete`, `llm:chat`, `llm:embed` syscalls
- Uses `hal.network` for HTTP calls to external APIs

**AI Agents (userspace processes)**
- Each agent is a **user principal** with its own identity
- Runs as a process with a PID, managed by ProcessTable
- Has a home directory: `/home/agent-{name}/`
- Owns its memory as files in home directory
- Coordinates tool use and LLM inference
- Spawns shell/coreutils for text processing
- Multiple agents can run in parallel with different specializations

**Agent Home Directory Structure**
```
/home/agent-coder/
  .config/
    agent.json           # agent configuration (model, specialization, etc.)
    token                # JWT for authentication (provisioned by admin/init)
  .memory/
    agent.db             # SQLite database (STM, LTM, procedural, embeddings)
  .cache/                # temporary working data
```

**Userspace Tools**
- `/bin/shell` - command interpreter
- `/bin/sql` - SQLite CLI for database access
- `/bin/cat`, `/bin/grep`, `/bin/awk`, etc. - text processing tools
- Agents spawn these as child processes

**HAL**
- Pure hardware abstraction (file, network, block)
- No LLM knowledge - just provides network transport

---

## Agent Runtime

AI agents are userspace processes, not kernel services. They use existing syscalls.

### Agent Process Lifecycle

```
1. Spawn agent process (fork/exec rom/bin/agent)
2. Agent reads JWT from ~/.config/token
3. Agent calls auth:token to authenticate → sets proc.user
4. Agent reads config from ~/.config/agent.json
5. Agent loads memory from ~/.memory/
6. Agent enters request loop:
   - Receive task (IPC, stdin, or message queue)
   - Plan using llm:complete
   - Execute tools (spawn shell, read files, etc.)
   - Update memory files
   - Return result
7. Agent exits or persists as daemon
```

### Syscalls Used by Agents

Agents use standard syscalls - no special `ai:*` syscalls needed:

| Syscall | Agent Use |
|---------|-----------|
| `auth:token` | Authenticate on startup (JWT from ~/.config/token) |
| `llm:complete` | Generate plans, responses, summaries |
| `llm:chat` | Multi-turn reasoning |
| `llm:embed` | Generate embeddings for semantic search |
| `vfs:read` | Load memory, read context files |
| `vfs:write` | Persist memory, save outputs |
| `process:spawn` | Execute shell commands, run tools |

### Example Agent Loop

```typescript
// rom/bin/agent - simplified agent main loop
async function main() {
  // Authenticate first - required before any other syscalls
  const token = await vfs.read('~/.config/token');
  await syscall('auth:token', { jwt: token });

  // Now authenticated as this agent user
  const config = await vfs.read('~/.config/agent.json');
  const memory = new AgentMemory('~/.memory/agent.db');

  while (true) {
    const task = await receiveTask();

    // Plan using LLM
    const plan = await syscall('llm:complete', {
      model: config.model,
      prompt: `Task: ${task}\nContext: ${memory.getRecentTurns(10)}\nPlan:`
    });

    // Execute plan (spawn shell, etc.)
    const result = await executeSteps(plan);

    // Update memory
    memory.appendTurn('user', task);
    memory.appendTurn('assistant', result);

    await sendResult(result);
  }
}
```

---

## Agent Authentication

Agents are service accounts - they authenticate via JWT, not passwords. See `docs/planning/OS_AUTH.md` for full Auth subsystem design.

### Provisioning Flow

Agent users and tokens are provisioned by internal code (init scripts, admin tools), which bypasses the dispatcher and runs without auth:

```
Admin/Init script (internal, no auth needed)
    │
    ├── 1. Create user in EMS:
    │      ems.ops.createOne('auth_user', {
    │        username: 'agent-coder',
    │        password_hash: null,  // no password, JWT-only
    │      })
    │
    ├── 2. Create home directory:
    │      vfs.mkdir('/home/agent-coder')
    │      vfs.mkdir('/home/agent-coder/.config')
    │      vfs.mkdir('/home/agent-coder/.memory')
    │
    ├── 3. Mint JWT via HAL crypto (or auth:grant if authenticated):
    │      hal.crypto.signJWT({
    │        sub: 'agent-coder',
    │        scope: ['vfs:*', 'llm:*'],  // agent-specific permissions
    │        exp: ...,  // long-lived, e.g., 1 year
    │      })
    │
    └── 4. Write token to home directory:
           vfs.write('/home/agent-coder/.config/token', jwt)
```

### Runtime Authentication

When an agent process starts, it authenticates like any other service:

```
Agent process spawns (external, needs auth)
    │
    ├── 1. Read token from ~/.config/token
    │
    ├── 2. Call auth:token with JWT
    │      → Validates signature and expiry
    │      → Sets proc.user = 'agent-coder'
    │      → Sets proc.session, proc.expires
    │
    └── 3. Subsequent syscalls allowed as 'agent-coder'
           → VFS checks ACLs against proc.user
           → Dispatcher checks scope against syscall
```

### Scoped Tokens

Agents can have limited permissions via JWT scopes (see OS_AUTH.md Phase 4):

| Agent Type | Typical Scopes | Rationale |
|------------|----------------|-----------|
| coder | `vfs:*`, `llm:*` | Full file access, LLM inference |
| research | `vfs:read`, `llm:*` | Read-only file access |
| chat | `llm:*` | LLM only, no file access |
| monitor | `ems:read`, `vfs:read` | Read-only for dashboards |

Dispatcher enforces scopes - an agent with `vfs:read` cannot call `vfs:write`.

### Token Refresh

Long-lived tokens (e.g., 1 year) rarely need refresh. If needed, agents follow the same 50% TTL refresh strategy as other clients:

```typescript
// In agent startup
if (shouldRefresh(decode(token))) {
  const result = await syscall('auth:token', { jwt: token });
  await vfs.write('~/.config/token', result.token);
}
```

---

## Memory Model

Each agent owns a SQLite database in its home directory. This provides queryable, transactional storage without kernel dependency.

### Database Location

```
~/.memory/
  agent.db           # SQLite database (single file)
```

### Why SQLite Per-Agent

| Benefit | How |
|---------|-----|
| Queryable | Full SQL - indexes, joins, WHERE clauses |
| File ownership | Agent owns `~/.memory/agent.db` |
| Isolated | No shared state, no kernel dependency |
| Transactional | SQLite handles concurrent access |
| Inspectable | `/bin/sql ~/.memory/agent.db ".tables"` |
| Portable | Move agent = copy home directory |
| Lightweight | SQLite is designed for embedded use |

### Database Schema

```sql
-- ~/.memory/agent.db

-- Short-term memory (conversation turns)
CREATE TABLE stm (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,        -- 'user', 'assistant', 'system'
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_stm_ts ON stm(ts);

-- Long-term memory (consolidated knowledge)
CREATE TABLE ltm (
  id INTEGER PRIMARY KEY,
  topic TEXT,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_ltm_topic ON ltm(topic);
CREATE INDEX idx_ltm_ts ON ltm(ts);

-- Procedural memory (successful patterns)
CREATE TABLE procedural (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL,     -- what kind of request
  pattern TEXT NOT NULL,     -- what worked
  success_count INTEGER DEFAULT 1,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_procedural_trigger ON procedural(trigger);

-- Embeddings (for semantic search)
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  vector BLOB NOT NULL       -- serialized float array
);
CREATE INDEX idx_embeddings_source ON embeddings(source_table, source_id);
```

### SQL Tool (`/bin/sql`)

Userspace tool for interacting with SQLite databases:

```bash
# Interactive mode
/bin/sql ~/.memory/agent.db

# Execute query
/bin/sql ~/.memory/agent.db "SELECT * FROM stm ORDER BY ts DESC LIMIT 10"

# Execute commands
/bin/sql ~/.memory/agent.db ".tables"
/bin/sql ~/.memory/agent.db ".schema stm"

# Import/export
/bin/sql ~/.memory/agent.db ".dump" > backup.sql
/bin/sql ~/.memory/agent.db < backup.sql
```

The agent runtime library (`rom/lib/agent/`) provides higher-level helpers:

```typescript
// rom/lib/agent/memory.ts
class AgentMemory {
  constructor(dbPath: string);

  // STM operations
  appendTurn(role: string, content: string): void;
  getRecentTurns(limit: number): Turn[];
  pruneOldTurns(maxAge: number): void;

  // LTM operations
  remember(topic: string, content: string): void;
  recall(topic: string): Entry[];
  search(query: string): Entry[];  // FTS if enabled

  // Procedural operations
  recordSuccess(trigger: string, pattern: string): void;
  findPattern(trigger: string): Pattern | null;
}
```

### Memory Consolidation ("Sleep")

STM accumulates during active use. Agents can consolidate during idle periods:

```typescript
// Agent consolidation process
async function consolidate(memory: AgentMemory) {
  // Get recent STM turns
  const recentTurns = memory.getRecentTurns(100);

  // Extract key information via LLM
  const summary = await syscall('llm:complete', {
    model: 'default',
    prompt: 'Extract key facts and patterns worth remembering long-term',
    context: JSON.stringify(recentTurns)
  });

  // Store to LTM
  memory.remember('daily-summary', summary);

  // Prune old STM (older than 48 hours)
  memory.pruneOldTurns(48 * 60 * 60 * 1000);
}
```

Like human sleep: experiences accumulate during the day, important patterns consolidate overnight, noise is forgotten.

---

## Tool Execution

Agents use shell and coreutils as tools. This avoids reimplementing text processing.

### Flow

```
User: "Find log files with errors and count them"
                    │
                    ▼
Agent process:
  1. Load STM/LTM from ~/.memory/
  2. Call llm:complete to plan: "grep -l 'error' /var/log/*.log | wc -l"
  3. Spawn /bin/shell with command
  4. Capture output
  5. Call llm:complete to format response
  6. Append interaction to ~/.memory/stm.json
  7. Return to user
```

### Why Shell/Coreutils?

- Already handles edge cases (quoting, escaping, pipes)
- Composable via pipes
- LLMs can generate shell commands (well-documented in training data)
- No need to reimplement grep, awk, sed, etc.
- Agent inherits user permissions - shell commands run as agent user

---

## LLM Subsystem

The LLM subsystem is a kernel service that reads configuration from EMS and dispatches to provider-specific adapters.

### EMS Entities

Provider and model configuration lives in EMS, not flat config files. Adding a new provider or model is an EMS insert, not a code change.

**Schema ownership:** These tables are defined in `src/llm/schema.sql`, not EMS core. The LLM subsystem loads its schema during `LLM.init()` via `ems.exec()`. Table names use underscores (`llm_provider`) per SQL convention.

```typescript
// Provider configuration (how to connect)
interface LLMProvider {
  model: 'llm.provider';
  provider_name: string;      // 'ollama', 'anthropic', 'openai'
  api_format: string;         // 'openai' | 'anthropic' (wire protocol)
  auth_type: string;          // 'none' | 'bearer' | 'x-api-key'
  auth_value?: string;        // API key (or reference to secret)
  endpoint: string;           // 'http://localhost:11434', 'https://api.anthropic.com'
  streaming_format: string;   // 'ndjson' | 'sse'
}

// Model configuration (what it can do)
interface LLMModel {
  model: 'llm.model';
  provider: string;           // FK → llm.provider
  model_id: string;           // 'qwen2.5-coder:1.5b', 'claude-sonnet-4-20250514'

  // Capabilities (boolean flags)
  supports_chat: boolean;
  supports_completion: boolean;
  supports_streaming: boolean;
  supports_embeddings: boolean;
  supports_vision: boolean;
  supports_tools: boolean;

  // Limits
  context_window: number;     // 32768, 200000, etc.
  max_output: number;         // 4096, 8192, etc.

  // Behavioral flags
  strip_markdown: boolean;    // Post-process to remove ```fences
  system_prompt_style: string; // 'message' | 'prefix'
}
```

### Syscalls (llm:*)

| Syscall | Description |
|---------|-------------|
| `llm:complete` | One-shot completion (prompt → response) |
| `llm:chat` | Chat format (messages array → response) |
| `llm:stream` | Streaming completion |
| `llm:embed` | Generate embeddings |

### Example

```typescript
// LLM subsystem reads config from EMS, caller just specifies model
const response = await syscall('llm:complete', {
  model: 'qwen2.5-coder:1.5b',
  prompt: 'Output only the shell command: list files by size'
});

// Under the hood:
// 1. Lookup llm.model where model_id = 'qwen2.5-coder:1.5b'
// 2. Lookup llm.provider where id = model.provider
// 3. Dispatch to adapters[provider.api_format]
// 4. Apply model.strip_markdown if set
// 5. Return response
```

### Adapters

Only two adapters needed (most providers speak one of these):

| Adapter | Providers |
|---------|-----------|
| `openai` | OpenAI, Ollama, Together, Groq, local |
| `anthropic` | Anthropic |

The adapter handles:
- Request/response format transformation
- Authentication header format
- Streaming protocol differences
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

### Phase 1: LLM Subsystem (Kernel)

1. Create `src/llm/schema.sql` with `llm_provider` and `llm_model` tables
2. Create `src/llm/llm.ts` with `LLM.init()` that calls `ems.exec(schema)`
3. Implement OpenAI-format adapter (covers Ollama)
4. Implement `llm:complete` syscall
5. Seed initial provider/model records for Ollama

**Pattern:** Follow VFS schema split - subsystem owns its schema file, loads via `ems.exec()` during init.

### Phase 2: Shell + Coreutils (Userspace)

1. Reintroduce `/bin/shell` to OS userspace
2. Add basic coreutils (`cat`, `grep`, `head`, `tail`, `wc`)
3. Add `/bin/sql` - SQLite CLI for userspace database access
4. Ensure tools can be spawned as child processes

### Phase 3: Agent Runtime (Userspace)

1. Create `rom/bin/agent` - base agent executable
2. Create `rom/lib/agent/` - shared agent library code
3. Create `rom/lib/agent/memory.ts` - AgentMemory class wrapping SQLite
4. Implement agent lifecycle (spawn, authenticate, run, shutdown)
5. Create agent provisioning script:
   - Create `auth_user` entry (no password, JWT-only)
   - Create home directory structure (`~/.config/`, `~/.memory/`)
   - Mint scoped JWT via `auth:grant` or HAL crypto
   - Write token to `~/.config/token`
   - Initialize `~/.memory/agent.db` with schema

### Phase 4: Agent Specializations

1. Create specialized agent configs (coder, research, chat)
2. Implement tool execution (shell spawning)
3. Add memory consolidation
4. Implement context window management

### Phase 5: Advanced

1. Streaming responses (`llm:stream`)
2. Anthropic adapter
3. Multi-agent coordination
4. Embedding/vector search for semantic memory

---

## Open Questions

### 1. Embedding Storage

Should embeddings live in agent home directory or a shared location?

| Option | Pros | Cons |
|--------|------|------|
| Per-agent (`~/.memory/embeddings/`) | Simple, isolated | Duplication across agents |
| Shared (`/var/embeddings/`) | Reusable, efficient | Needs access control |

### ~~2. Agent Provisioning~~ (Resolved)

**Resolution:** Agents are service accounts. Provisioning is done by internal code (init scripts, admin tools) that bypasses the dispatcher:

1. Create `auth_user` entry (no password)
2. Create home directory structure
3. Mint scoped JWT via HAL crypto or `auth:grant`
4. Write token to `~/.config/token`

See "Agent Authentication" section above for full details.

### 3. Inter-Agent Communication

How do agents coordinate on complex tasks?

| Option | Notes |
|--------|-------|
| Message queue | Agents publish/subscribe to topics |
| Direct IPC | Agents connect via sockets/pipes |
| Shared files | Agents read/write to shared workspace |

### 4. Agent Supervision

Who monitors agent behavior?

| Option | Notes |
|--------|-------|
| User review | User approves destructive operations |
| Supervisor agent | Meta-agent monitors other agents |
| Audit log | All agent actions logged for review |

---

## References

### Kernel (LLM Subsystem)
- `src/vfs/schema.sql` - VFS schema (reference for LLM schema pattern)
- `src/vfs/vfs.ts` - VFS.init() shows how to load subsystem schema via `ems.exec()`
- `src/ems/schema.sql` - EMS core schema (entities, models, fields, tracked)

### Userspace (Agents)
- `rom/lib/shell/` - Existing shell implementation (to reintroduce)
- `src/kernel/process-table.ts` - Process management (agent PIDs)

### Related Planning Docs

- `docs/planning/OS_AUTH.md` - Auth subsystem (agent authentication, JWT, scopes)
- `docs/implemented/EMS_SCHEMA_SPLIT.md` - Schema split architecture
- `docs/implemented/VFS_PATH_CACHE.md` - PathCache refactor
