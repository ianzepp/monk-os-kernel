# ROM Coreutils - Missing Commands

> **Status**: Partial (in progress)
> **Complexity**: Variable per command
> **Dependencies**: Process library, VFS syscalls

Inventory of missing coreutil commands, prioritized for AI agent use cases.

---

## Current Inventory (57 commands)

```
awk       basename  bc        cat       cd        chmod     cp        create
cut       date      delete    describe  df        dirname   du        echo
env       expire    false     file      find      grant     grep      head
kill      ln        ls        mkdir     mv        nl        printf    ps
pwd       realpath  revert    rm        rmdir     sed       select    seq
shell     sleep     sort      stat      tail      tee       test      timeout
touch     tr        true      uname     uniq      update    wc        whoami
yes
```

### Shell Built-ins (in shell.ts)

These are implemented as shell built-ins, not separate commands:

- `cd` - Change directory
- `export` - Set environment variable
- `exit` - Exit shell
- `source` / `.` - Source script in current context
- `true` / `false` - Return success/failure
- `test` / `[` - Conditional expressions
- `read` - Read line from stdin into variable

---

## Implemented (Priority 1)

These essential commands have been implemented:

| Command | Status | Notes |
|---------|--------|-------|
| `env` | Done | Print environment variables |
| `export` | Done | Shell built-in |
| `test` / `[` | Done | Shell built-in with file/string/numeric tests |
| `read` | Done | Shell built-in with -r, -p options |
| `timeout` | Done | Run with time limit, -s, -k options |
| `kill` | Done | Signal processes, -s, -l options |
| `ps` | Done | List processes with PID, PPID, STATE, USER, CMD |

---

## Still Missing (Priority 1)

| Command | Purpose | AI Use Case |
|---------|---------|-------------|
| `xargs` | Build commands from stdin | Pipeline composition |
| `diff` | Compare files | Verify changes, review edits |
| `mktemp` | Create temp file/dir safely | Safe scratch space |
| `base64` | Encode/decode base64 | Binary data handling |
| `md5sum` | MD5 checksum | Verify file integrity |
| `sha256sum` | SHA-256 checksum | Cryptographic verification |

### Implementation Notes

**`xargs`**: Essential for pipelines. Minimum viable:
- `-I {}` for placeholder substitution
- `-n N` for batching
- `-0` for null-delimited input

**`diff`**: AI needs to verify its own changes. Options:
- Unified format (`-u`) is most useful
- Could start simple: line-by-line comparison

**`mktemp`**: Safe temp file creation:
- `-d` for directories
- Template support (e.g., `tmp.XXXXXX`)

---

## Priority 2: Useful Shell Operations

Commands that significantly improve shell scripting capability.

| Command | Purpose | AI Use Case |
|---------|---------|-------------|
| `expr` | Evaluate expressions | Arithmetic in scripts |
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

## Commands Likely NOT Needed

These standard coreutils probably don't apply to the virtual OS:

- `mount`/`umount` - VFS handles this differently
- `chown`/`chgrp` - Simplified permission model
- `mknod`/`mkfifo` - No device files
- `sync` - No physical disk
- `install` - Package manager handles this

---

## Resolved Questions

1. **Shell built-ins vs external commands?** - Resolved: `test`, `read`, `export` are shell built-ins in `shell.ts`. This matches traditional Unix behavior and allows them to modify shell state.

2. **Streaming checksums?** - Open: md5sum/sha256sum on large files should stream, not load entire file.

3. **diff algorithm?** - Open: Full Myers diff or simpler line-based?

4. **xargs parallelism?** - Open: Support `-P` for parallel execution?

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

Use `parseArgs()` with `numericShorthand` option to handle this pattern automatically.

---

## References

- GNU Coreutils: https://www.gnu.org/software/coreutils/
- POSIX Utilities: https://pubs.opengroup.org/onlinepubs/9699919799/utilities/
- `prompts/userspace-dev.md` - Implementation patterns and code review prompt
- `prompts/coreutils.md` - Quick reference patterns
