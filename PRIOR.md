# Prior

Prior is the primary AI agent in Monk OS. It runs as PID 1, listens on TCP port 7777, and executes tasks using shell commands and syscalls.

## Quick Start

```bash
# Start the OS
bun start:sqlite

# Send a task
(echo '{"task": "list files in /bin"}'; sleep 10) | nc localhost 7777
```

## Architecture

```
External Client (Claude Code, Abbot, nc)
         │
         │ TCP :7777
         ▼
┌─────────────────────────────────────┐
│  Prior (PID 1)                      │
│                                     │
│  1. Receive task JSON               │
│  2. Call LLM with system prompt     │
│  3. Parse ! commands from response  │
│  4. Execute commands                │
│  5. Feed output back to LLM         │
│  6. Repeat until no ! commands      │
│  7. Return final response           │
└─────────────────────────────────────┘
         │
         │ syscalls
         ▼
┌─────────────────────────────────────┐
│  Kernel (LLM, VFS, Process, etc.)   │
└─────────────────────────────────────┘
```

## Task Protocol

Send JSON over TCP:

```json
{"task": "how many files are in /bin?"}
{"task": "create a file at /tmp/test.txt with 'hello'", "model": "claude-sonnet-4"}
```

Receive JSON response:

```json
{
  "status": "ok",
  "result": "There are 45 files in /bin.",
  "model": "claude-sonnet-4",
  "duration_ms": 3200
}
```

## ! Commands

Prior executes tasks by outputting ! commands. The agentic loop parses these, runs them, and feeds results back to the LLM.

### !exec - Shell Pipeline

```
!exec ["ls -la /bin"]
!exec ["find /etc -name '*.txt' | head -5"]
!exec ["cat file.txt", "grep error", "wc -l"]
```

- Array elements are piped together
- Shell operators (`|`, `&&`, `;`) within strings are also handled
- Output is captured and fed back to LLM

### !call - Direct Syscall

```
!call file:stat "/etc/hosts"
!call file:readdir ["/bin"]
!call proc:getpid
!call proc:getcwd
```

Syscall namespaces:
- `file:*` - stat, readdir, mkdir, open, read, write, unlink
- `proc:*` - spawn, wait, exit, getpid, getcwd, chdir
- `llm:*` - complete, chat, stream, embed
- `ems:*` - query, create, update, delete
- `port:*` - create, recv, close
- `handle:*` - send, close, redirect

### !help - Show Commands

```
!help
```

Returns contents of `/etc/prior/help.txt`.

### !spawn - Async Subagent

```
!spawn "summarize /var/log"
!spawn {"task": "count files in /bin", "model": "claude-haiku-3"}
```

- Starts a subagent to handle the task asynchronously
- Returns a spawn ID (e.g., `spawn:a1b2c3d4`)
- Subagent inherits Prior's context and identity
- Use `!wait` to retrieve result

### !wait - Wait for Subagent

```
!wait spawn:a1b2c3d4
```

- Blocks until the spawned task completes
- Returns the subagent's result
- Cleans up the spawn entry

### !stm / !ltm - Memory (Reserved)

```
!stm <operation>
!ltm <operation>
```

Short-term and long-term memory. Not yet implemented.

## Self-Discovery

On first kernel tick after boot, Prior performs self-discovery:

```
prior: tick 1 - performing self-discovery
prior: !exec ["pwd && whoami && uname -a"]
prior: result: /\nroot\nMonk monk 1.0.0...
prior: self-discovery complete
prior: identity saved to /var/prior/identity.txt
```

The LLM explores its environment and writes an identity statement.

## Memory

Prior maintains state in `/var/prior/`:

| File | Purpose |
|------|---------|
| `identity.txt` | Self-discovery result, loaded at startup |
| `session.log` | Append-only task history |
| `context.txt` | Distilled context (future: monk-maintained) |

## Agentic Loop

```
1. Build prompt with identity + memory context + task
2. Call llm:complete
3. Parse response for ! commands
4. If no ! commands → return final response
5. Execute each ! command, collect output
6. Append output to conversation
7. Goto 2 (max 10 iterations)
```

## Configuration

| Setting | Default | Location |
|---------|---------|----------|
| Port | 7777 | `rom/bin/prior.ts` |
| Model | claude-sonnet-4 | `rom/bin/prior.ts` |
| System prompt | - | `rom/etc/prior/system.txt` |
| Help text | - | `rom/etc/prior/help.txt` |
| Max iterations | 10 | `rom/bin/prior.ts` |

## Files

```
rom/
  bin/
    prior.ts              # Main executable
  etc/
    prior/
      system.txt          # System prompt for LLM
      help.txt            # !help output

/var/prior/               # Runtime state (in VFS)
  identity.txt
  session.log
  context.txt
```

## Future

- **!stm / !ltm**: Memory read/write commands
- **Monk workers**: Prior spawns monks for parallel subtasks
- **Distillation**: Background monks consolidate session.log → context.txt
- **Embeddings**: Semantic search over memory
