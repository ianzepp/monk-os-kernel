# Prior Memory Architecture

## Overview

Prior's memory system mirrors human memory: recent experiences are vivid, older ones fade into summaries, and lasting insights persist long-term. This enables infinite-length conversations with graceful degradation of old detail.

## Three-Layer Model

```
┌─────────────────────────────────────────────────────────────┐
│                    conversation[]                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐│
│  │   LTM    │ │ summary  │ │ summary  │ │  recent messages ││
│  │ entries  │ │ (older)  │ │ (recent) │ │    (verbatim)    ││
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘│
│       ↑            ↑            ↑                           │
│   pre-loaded    compacted    compacted                      │
│   on start      mid-task     mid-task                       │
└─────────────────────────────────────────────────────────────┘
        │                │
        │                ↓
        │         ┌─────────────┐
        │         │   ai_stm    │  Short-term memory
        │         │  (SQLite)   │  Compressed chunks from conversations
        │         └──────┬──────┘
        │                │
        │                │ consolidation (~10 min)
        │                ↓
        │         ┌─────────────┐
        └─────────│   ai_ltm    │  Long-term memory
                  │  (SQLite)   │  Distilled insights
                  └─────────────┘
```

## Conversation Array

The live working memory. Structured as:

```typescript
conversation: Array<{
    role: 'user' | 'assistant' | 'exec' | 'ltm' | 'stm';
    content: string;
}>
```

### Composition (oldest to newest)

1. **LTM entries** (role: `ltm`) - Pre-loaded relevant long-term memories
2. **STM summaries** (role: `stm`) - Compacted older messages
3. **Recent messages** (role: `user`/`assistant`/`exec`) - Verbatim recent history

### Example

```
[ltm]      User prefers concise answers
[ltm]      Project uses TypeScript with Bun runtime
[stm]      Earlier: listed /bin contents, found 47 executables including cat, grep, ls
[stm]      Earlier: explored /etc structure, identified config files
[user]     Now check what's in /var/log
[assistant] !exec ["ls -la /var/log"]
[exec]     total 128\ndrwxr-xr-x 2 root root...
[assistant] The /var/log directory contains...
```

## Sliding Window Compaction

As conversation grows, older messages are progressively compressed.

### Trigger

When conversation reaches ~40% of context window capacity.

### Process

1. Select oldest N messages (excluding LTM entries)
2. Send to worker LLM: "Summarize this conversation chunk"
3. Replace messages 1-N with single summary message
4. Write summary to STM (for cross-task persistence)
5. Continue conversation

### Result

```
Before: [m1][m2][m3][m4][m5][m6][m7][m8][m9][m10][m11]...[m20]
After:  [summary of 1-10][m11]...[m20]
```

Conversation never hits the wall. Recent detail preserved, old detail compressed.

## Short-Term Memory (ai_stm)

**Purpose**: Store compressed conversation chunks for cross-task memory.

**When written**: During task execution, each time compaction triggers.

**Contents**: Summaries of conversation chunks, not raw messages.

**Lifecycle**:
- Created during compaction
- Read during consolidation
- Marked as consolidated after LTM extraction
- Eventually pruned

### Schema

```sql
ai_stm (
    id              TEXT PRIMARY KEY,
    created_at      TEXT,
    content         TEXT NOT NULL,      -- The compressed summary
    context         TEXT,               -- JSON: task_id, source, etc.
    salience        INTEGER DEFAULT 5,  -- 1-9, affects consolidation priority
    consolidated    INTEGER DEFAULT 0,  -- Has been processed
    consolidated_at TEXT
)
```

## Long-Term Memory (ai_ltm)

**Purpose**: Store distilled insights that persist across sessions.

**When written**: During consolidation (every ~10 minutes or via `!coalesce`).

**Contents**: Abstract knowledge extracted from STM summaries.

**Lifecycle**:
- Created during consolidation
- Reinforced when similar insights re-appear
- Decays if never accessed
- Pre-loaded into new conversations

### Schema

```sql
ai_ltm (
    id              TEXT PRIMARY KEY,
    created_at      TEXT,
    updated_at      TEXT,
    content         TEXT NOT NULL,      -- The insight
    category        TEXT,               -- user_prefs, project_facts, lessons, etc.
    source_ids      TEXT,               -- JSON array of STM ids
    reinforced      INTEGER DEFAULT 1,  -- Strength (higher = more retrievals)
    last_accessed   TEXT                -- For decay tracking
)
```

### Categories

- `user_prefs` - User preferences and style
- `project_facts` - Codebase knowledge, architecture
- `lessons` - What worked, what didn't
- `patterns` - Recurring approaches
- `corrections` - Mistakes to avoid

## Consolidation Process

Runs every ~10 minutes or on `!coalesce` command.

### Steps

1. Query unconsolidated STM entries, ordered by salience
2. Send to LLM: "Extract lasting insights from these summaries"
3. For each insight:
   - Check if similar LTM exists → reinforce
   - Otherwise → create new LTM entry
4. Mark STM entries as consolidated

### Prompt Pattern

```
Review these conversation summaries and extract lasting insights.
For each insight, output: {"content": "...", "category": "..."}

Summaries:
[1] (salience=7) User asked about error handling, preferred Result<T> pattern
[2] (salience=5) Listed files in /bin, found standard Unix utilities
[3] (salience=8) User corrected: use Bun.spawn not child_process

Output only insights worth remembering long-term.
```

## LTM Pre-loading

At task start, relevant LTM entries are injected into conversation.

### Selection Strategies

1. **Top N by reinforcement** - Strongest memories always included
2. **Keyword match** - Match task content against LTM
3. **Category priority** - Always include `user_prefs`

### Implementation

```typescript
// Before building conversation
const ltmEntries = await selectRelevantLTM(task, {
    maxEntries: 5,
    alwaysInclude: ['user_prefs'],
    minReinforcement: 2,
});

for (const entry of ltmEntries) {
    conversation.push({
        role: 'ltm',
        content: `[${entry.category}] ${entry.content}`,
    });
}
```

## Commands

### !ref <keywords>

Search both STM and LTM by keywords. Returns matching memories.

```
!ref typescript error handling
```

### !coalesce

Force immediate consolidation cycle:
1. Compact current conversation (if needed)
2. Process all unconsolidated STM → LTM

```
!coalesce
```

## Token Economics

| Layer | Size | Detail Level | Persistence |
|-------|------|--------------|-------------|
| Recent messages | ~60% of context | Verbatim | Task duration |
| Summaries | ~30% of context | Compressed | Task duration + STM |
| LTM entries | ~10% of context | Abstract | Permanent |

## Flow Diagram

```
                    ┌─────────────────┐
                    │   User Task     │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  Pre-load LTM   │
                    │  (top memories) │
                    └────────┬────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │      Agentic Loop            │
              │  ┌────────────────────────┐  │
              │  │ conversation grows     │  │
              │  │         │              │  │
              │  │    40% threshold?      │  │
              │  │     /          \       │  │
              │  │   no            yes    │  │
              │  │    │             │     │  │
              │  │    │      ┌──────▼───┐ │  │
              │  │    │      │ compact  │ │  │
              │  │    │      │ oldest N │ │  │
              │  │    │      │ → STM    │ │  │
              │  │    │      └──────┬───┘ │  │
              │  │    │             │     │  │
              │  │    └──────┬──────┘     │  │
              │  │           │            │  │
              │  │     continue loop      │  │
              │  └────────────────────────┘  │
              └──────────────┬───────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  Task Complete  │
                    └────────┬────────┘
                             │
                             ▼
               ┌─────────────────────────────┐
               │  Periodic Consolidation     │
               │  STM → LTM (every ~10 min)  │
               └─────────────────────────────┘
```

## Tick Cycles

Prior runs tiered maintenance cycles at increasing intervals, like sleep stages.

| Interval | Ticks | Cycle | Activity |
|----------|-------|-------|----------|
| 10 min | 600 | **Consolidate** | STM → LTM |
| 1 hour | 3600 | **Reflect** | Review recent LTM, find patterns |
| 6 hours | 21600 | **Learn** | Extract lessons, update self-instructions |
| 24 hours | 86400 | **Decay** | Reduce reinforcement on unaccessed memories |

Each deeper cycle does more abstract processing:

### Consolidate (10 min)

"What happened?"

- Query unconsolidated STM entries
- Extract facts and insights → LTM
- Mark STM as processed

### Reflect (1 hour)

"What's the pattern?"

- Review LTM entries created in last hour
- Look for recurring themes
- Create higher-level pattern entries
- Reinforce related memories

### Learn (6 hours)

"What should I do differently?"

- Review patterns and lessons from LTM
- Extract actionable rules
- Write to `/etc/prior/learned.txt`
- These become permanent self-instructions

### Decay (24 hours)

"What can I forget?"

- Query all LTM entries
- Reduce `reinforced` by 1 for entries not accessed since last decay
- Memories that keep getting retrieved stay strong
- Memories at reinforced=0 may be archived or deleted

```
reinforced: 5 → 4 → 3 → 2 → 1 → 0 (forgotten)
```

Decay is passive and organic. Memories don't get deleted, they fade. A decayed memory is still there, just less likely to surface. If it becomes relevant again (`!ref` matches), it can be reinforced back up.

## Design Principles

1. **Never hit the wall** - Proactive compaction, not reactive truncation
2. **Recent detail matters** - Preserve verbatim recent, compress old
3. **Memory is lossy** - Accept graceful degradation like human memory
4. **Cross-task learning** - STM/LTM bridge conversations
5. **Reinforcement** - Repeated insights get stronger
6. **Decay** - Unused memories fade (future: archive or delete)
