# Parallel Agent Processing Guide

Use this approach to streamline large bulk processing tasks across multiple files.

---

## When to Use Parallel Agents

- Converting/refactoring many files with the same transformation
- Applying consistent changes across a codebase
- Tasks where files can be processed independently
- When sequential processing would take too long

## When NOT to Use

- Files that depend on each other's output
- Tasks requiring incremental learning/refinement
- Very small batches (< 4 files) - sequential is simpler
- When you need tight control over consistency

---

## The Approach

### 1. Survey the Work

First, list the files to understand scope and size:

```bash
ls -la /path/to/directory/
```

Note file sizes to balance workload across agents.

### 2. Determine Agent Count

Rules of thumb:
- **2-4 files**: 2 agents
- **5-8 files**: 3-4 agents
- **9+ files**: 4-5 agents (diminishing returns beyond 5)

Balance by total bytes, not just file count. Give larger files their own agent.

### 3. Craft the Agent Prompt

Each agent needs:

```
**Read these files first:**
1. [Standards/template file] - The rules to follow
2. [Example file] - A completed example for reference

**Your task:** Convert these N files to [format]:
1. /absolute/path/to/file1.ts
2. /absolute/path/to/file2.ts

**Process for each file:**
1. Read the file
2. Write the converted version to {filename}.new
3. Move the .new file over the original

**Requirements:**
- [Specific requirement 1]
- [Specific requirement 2]
- Keep all existing functionality intact

**Report back:** List files converted and confirm [verification step]
```

### 4. Launch in Parallel

Use a single message with multiple Task tool calls:

```
<Task agent1 - files A, B>
<Task agent2 - files C, D>
<Task agent3 - files E, F>
<Task agent4 - files G, H>
```

All agents run simultaneously.

### 5. Verify and Commit

After all agents complete:

```bash
# Verify compilation/tests pass
bun run typecheck

# Check all files were modified
git status --short /path/to/directory/

# Commit
git add /path/to/directory/
git commit -m "description"
```

---

## Example: Converting 8 Files

**Input:** 8 files in `src/kernel/handle/`

**Strategy:** 4 agents, 2 files each

| Agent | Files | Rationale |
|-------|-------|-----------|
| 1 | channel.ts, port.ts | Related functionality, medium size |
| 2 | console.ts, types.ts | Mixed sizes, balance workload |
| 3 | file.ts, socket.ts | Both are handle adapters |
| 4 | process-io.ts, index.ts | Largest file + small barrel |

**Results:**
- 8 files converted
- +2,170 lines added
- All completed in one parallel batch
- TypeCheck passed

---

## Tips

### Balancing Workload

```
Small files (~1KB):     Group 3-4 per agent
Medium files (~3-5KB):  Group 2 per agent
Large files (~8KB+):    Give dedicated agent
```

### Prompt Consistency

Give every agent:
- The **same** standards document
- The **same** example file
- The **same** requirements list

This ensures consistent output across agents.

### Verification Steps

Always include a verification command in the prompt:

```
**Report back:** ... and confirm typecheck passes (run: bun run typecheck)
```

Agents will run this and report issues.

### Error Recovery

If an agent fails or produces bad output:
1. Check what it reported
2. Run the failed file(s) through a new agent
3. Or fix manually if minor

### File Naming Convention

Use `.new` extension for in-progress work:
```
1. Write to file.ts.new
2. Move file.ts.new → file.ts
```

This prevents partial writes from corrupting originals.

---

## Performance Comparison

| Approach | 8 Files | 37 Files |
|----------|---------|----------|
| Sequential | ~20 min | ~90 min |
| Parallel (4 agents) | ~5 min | ~25 min |

Parallel processing is ~4x faster for bulk operations.
