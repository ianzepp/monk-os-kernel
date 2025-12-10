# ROM Coreutils - Missing Commands

> **Status**: Planning
> **Complexity**: Variable per command
> **Dependencies**: Process library, VFS syscalls

Inventory of missing coreutil commands, prioritized for AI agent use cases.

---

## Current Inventory (42 commands)

```
awk      basename  cat     cd      chmod   cp      cut     date
df       dirname   du      echo    false   file    grant   grep
head     ln        ls      mkdir   mv      nl      printf  pwd
realpath rm        rmdir   sed     seq     shell   sleep   sort
stat     tail      tee     touch   tr      true    uname   uniq
wc       whoami    yes
```

---

## Priority 1: Essential for AI Agents

Commands an AI absolutely needs for effective autonomous operation.

| Command | Purpose | AI Use Case |
|---------|---------|-------------|
| `env` | Print/set environment | Check context, runtime config |
| `export` | Set environment variable | Configure child processes |
| `test` / `[` | Conditional expressions | Script flow control |
| `xargs` | Build commands from stdin | Pipeline composition |
| `diff` | Compare files | Verify changes, review edits |
| `read` | Read line from stdin | Interactive input, prompts |
| `timeout` | Run with time limit | Prevent runaway processes |
| `mktemp` | Create temp file/dir safely | Safe scratch space |
| `base64` | Encode/decode base64 | Binary data handling |
| `md5sum` | MD5 checksum | Verify file integrity |
| `sha256sum` | SHA-256 checksum | Cryptographic verification |
| `kill` | Signal processes | Process management |
| `ps` | List processes | Monitor running tasks |

### Implementation Notes

**`test` / `[`**: Critical for shell scripting. Needs:
- File tests: `-e`, `-f`, `-d`, `-r`, `-w`, `-x`, `-s`
- String tests: `-z`, `-n`, `=`, `!=`
- Numeric tests: `-eq`, `-ne`, `-lt`, `-le`, `-gt`, `-ge`
- Logic: `!`, `-a`, `-o`

**`xargs`**: Essential for pipelines. Minimum viable:
- `-I {}` for placeholder substitution
- `-n N` for batching
- `-0` for null-delimited input

**`diff`**: AI needs to verify its own changes. Options:
- Unified format (`-u`) is most useful
- Could start simple: line-by-line comparison

---

## Priority 2: Useful Shell Operations

Commands that significantly improve shell scripting capability.

| Command | Purpose | AI Use Case |
|---------|---------|-------------|
| `expr` | Evaluate expressions | Arithmetic in scripts |
| `bc` | Arbitrary precision calc | Complex math |
| `shuf` | Shuffle/random selection | Sampling, randomization |
| `paste` | Merge lines horizontally | Data manipulation |
| `join` | Join files on common field | Data correlation |
| `comm` | Compare sorted files | Set operations |
| `expand` | Tabs to spaces | Text normalization |
| `fold` | Wrap lines at width | Text formatting |
| `rev` | Reverse characters | String manipulation |
| `id` | Print user/group IDs | Permission checks |
| `groups` | Print group memberships | Access verification |
| `hostname` | Print hostname | System identification |
| `printenv` | Print environment vars | Debug configuration |

---

## Priority 3: Data Processing

Commands for working with various data formats.

| Command | Purpose | AI Use Case |
|---------|---------|-------------|
| `od` | Octal/hex dump | Binary inspection |
| `xxd` | Hex dump and reverse | Binary editing |
| `strings` | Extract printable strings | Binary analysis |
| `split` | Split file into pieces | Chunk large files |
| `csplit` | Split by context/pattern | Document sectioning |
| `fmt` | Simple text formatter | Text cleanup |
| `column` | Format into columns | Tabular output |
| `numfmt` | Number formatting | Human-readable sizes |

---

## Priority 4: Archive/Compression

Commands for working with archives (lower priority if HAL handles).

| Command | Purpose | Notes |
|---------|---------|-------|
| `tar` | Archive files | May need HAL channel |
| `gzip`/`gunzip` | Compression | Consider bun's built-in |
| `zip`/`unzip` | ZIP format | Common interchange format |

---

## Priority 5: System/Process Control

Advanced process management (may overlap with shell built-ins).

| Command | Purpose | Notes |
|---------|---------|-------|
| `nohup` | Run immune to hangups | Background persistence |
| `nice` | Run with priority | Resource management |
| `wait` | Wait for process | Job control |
| `trap` | Handle signals | Cleanup handlers |
| `jobs` | List background jobs | Shell built-in? |
| `fg`/`bg` | Job control | Shell built-in? |

---

## Priority 6: Low Priority / Edge Cases

Rarely needed or better handled elsewhere.

| Command | Purpose | Notes |
|---------|---------|-------|
| `cal` | Calendar | Novelty |
| `factor` | Prime factors | Math novelty |
| `uptime` | System uptime | Status |
| `tty` | Print terminal name | Debug |
| `stty` | Terminal settings | May not apply |
| `clear` | Clear screen | Terminal control |
| `logger` | Log to syslog | If syslog exists |

---

## Implementation Recommendations

### Phase 1: AI Essentials
Focus on commands that enable autonomous operation:
1. `test` - Enables conditional scripts
2. `env` / `export` - Environment management
3. `diff` - Change verification
4. `xargs` - Pipeline power
5. `timeout` - Safety guardrails
6. `mktemp` - Safe temp files

### Phase 2: Data Handling
Enable working with various data:
1. `base64` - Binary encoding
2. `md5sum` / `sha256sum` - Integrity
3. `read` - Interactive input
4. `ps` / `kill` - Process control

### Phase 3: Shell Polish
Complete the shell experience:
1. `expr` / `bc` - Math
2. `shuf` - Randomization
3. `paste` / `join` / `comm` - Set operations
4. `diff` improvements (context, unified)

---

## Commands Likely NOT Needed

These standard coreutils probably don't apply to the virtual OS:

- `mount`/`umount` - VFS handles this differently
- `chown`/`chgrp` - Simplified permission model
- `mknod`/`mkfifo` - No device files
- `sync` - No physical disk
- `install` - Package manager handles this

---

## Open Questions

1. **Shell built-ins vs external commands?** - Some commands (test, read, export) are traditionally shell built-ins. Should they be separate binaries or integrated into shell.ts?

2. **Streaming checksums?** - md5sum/sha256sum on large files should stream, not load entire file.

3. **diff algorithm?** - Full Myers diff or simpler line-based?

4. **xargs parallelism?** - Support `-P` for parallel execution?

---

## Implementation Guidelines

See `prompts/userspace-dev.md` for the authoritative guide on implementing commands.

### GNU Shorthand Syntax

LLMs are trained primarily on GNU coreutils and naturally generate GNU-style syntax:

```bash
head -5 file.txt          # GNU shorthand
tail -20 file.txt         # GNU shorthand
```

But POSIX requires explicit option syntax:

```bash
head -n 5 file.txt        # POSIX
tail -n 20 file.txt       # POSIX
```

**Decision**: Support both. We control `/bin` and can implement whatever we want. Fighting the model's training is futile. Help text documents the POSIX form as canonical.

```typescript
// Pattern for numeric options
for (const arg of args) {
    if (arg.match(/^-\d+$/)) {
        // GNU shorthand: -5 means -n 5
        lines = parseInt(arg.slice(1), 10);
    }
    else if (arg === '-n' && i + 1 < args.length) {
        // POSIX: -n 5
        lines = parseInt(args[++i], 10);
    }
}
```

---

## References

- GNU Coreutils: https://www.gnu.org/software/coreutils/
- POSIX Utilities: https://pubs.opengroup.org/onlinepubs/9699919799/utilities/
- `prompts/userspace-dev.md` - Implementation patterns and code review prompt
- `docs/complete/COREUTILS_REPATRIATION.md` - Previous coreutils work
