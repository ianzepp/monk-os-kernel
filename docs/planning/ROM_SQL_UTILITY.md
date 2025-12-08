# ROM SQL Utility

> **Status**: Not Started
> **Complexity**: Medium
> **Dependencies**: Channel syscalls, HAL SQLite channel

SQLite CLI for userspace database access, primarily for agent memory.

---

## Background

From OS_AI.md: Each agent owns a SQLite database in `~/.memory/agent.db`. The `/bin/sql` utility provides command-line access to these databases.

### Use Cases

1. **Agent memory inspection** - Debug/inspect agent STM/LTM
2. **Manual queries** - Ad-hoc SQL against any .db file
3. **Schema management** - View tables, create indexes
4. **Backup/restore** - Dump and load databases

---

## Proposed Interface

```
Usage: sql <database> [query]
       sql <database> ".command"
       sql <database> < script.sql

Examples:
  sql ~/.memory/agent.db "SELECT * FROM stm ORDER BY ts DESC LIMIT 10"
  sql ~/.memory/agent.db ".tables"
  sql ~/.memory/agent.db ".schema stm"
  sql ~/.memory/agent.db ".dump" > backup.sql
  sql ~/.memory/agent.db < backup.sql
```

### Dot Commands

| Command | Description |
|---------|-------------|
| `.tables` | List all tables |
| `.schema [table]` | Show CREATE statement |
| `.dump [table]` | Dump as SQL |
| `.mode csv\|json\|table` | Output format |
| `.headers on\|off` | Show column headers |

---

## Implementation Options

### Option A: Via HAL Channel Syscalls

Use existing `channel:open('sqlite', path)` infrastructure:

```typescript
// Open database
const fd = await channelOpen('sqlite', dbPath);

// Execute query
for await (const row of channelCall(fd, { op: 'query', sql })) {
    // Each row is an item response
}

// Close
await channelClose(fd);
```

**Pros:**
- Uses existing HAL infrastructure
- Consistent with other protocol channels
- Process isolation maintained

**Cons:**
- Need to add channel syscalls to process library
- May have overhead for simple queries

### Option B: Direct bun:sqlite in Worker

If Workers can access `bun:sqlite` directly:

```typescript
import { Database } from 'bun:sqlite';
const db = new Database(path);
const rows = db.query(sql).all();
```

**Pros:**
- Simpler, direct access
- No syscall overhead

**Cons:**
- Unclear if bun:sqlite works in Worker context
- Breaks kernel/userspace boundary philosophy

### Option C: New db:* Syscalls

Add dedicated database syscalls:

```
db:open   - Open database file
db:query  - Execute SELECT (streaming rows)
db:exec   - Execute INSERT/UPDATE/DELETE
db:close  - Close database
```

**Pros:**
- Clean, purpose-built API
- Could support multiple database types

**Cons:**
- More kernel code
- Duplicates HAL channel functionality

---

## Open Questions

1. **Which implementation option?** - Leaning toward Option A (HAL channels)

2. **Interactive mode?** - Should sql support a REPL for interactive queries?

3. **Transaction support?** - BEGIN/COMMIT/ROLLBACK across multiple commands?

4. **Output formatting** - How to handle table formatting in message-based output?

---

## Dependencies

Before implementing:

1. Add channel syscalls to `rom/lib/process/`:
   - `channelOpen(proto, url, opts?)`
   - `channelCall(fd, msg)`
   - `channelClose(fd)`

2. Verify HAL SQLite channel works for file:// URLs

3. Decide on dot-command implementation (parse in userspace vs kernel support)

---

## References

- `docs/planning/OS_AI.md` - Agent memory model
- `src/hal/channel/sqlite.ts` - HAL SQLite channel
- `src/syscall/hal.ts` - Channel syscalls
