# Shell Commands Conversion: api/lib/tty/commands -> rom/bin

This document tracks the conversion of shell commands from the old `api/lib/tty/commands/`
implementation to the new `rom/bin/` syscall-based implementation.

## Summary (2024-11-30)

**Completed:** 29 commands converted
- Phase 1: true, false
- Phase 2: yes, seq, sleep, basename, dirname
- Phase 3: head, tail, wc, nl
- Phase 5: sort, uniq, tr, cut
- Phase 6: cp, mv, ln, chmod, tee
- New: grant (Monk-native ACL management)
- Phase 8: awk, sed
- Phase 7: date, uname, whoami, printf
- Pre-existing: cat, cd, echo, ls, mkdir, pwd, rm, rmdir, touch

**Blocked (need syscalls):**
- env: needs `listenv` syscall (to enumerate all environment variables)

**New Monk-native commands:**
- grant: ACL management (replaces chmod)

**Not started:** grep, find, tree, xargs, diff, sed, test, stat, file, readlink, realpath, du, df, mktemp

## Architecture Differences

### Old (api/lib/tty/commands/)
- Uses `CommandHandler` interface: `(session, fs, args, io) => Promise<number>`
- Direct access to FS object
- Streaming I/O via `io.stdin`, `io.stdout`, `io.stderr`
- Signal handling via `io.signal`

### New (rom/bin/)
- Uses syscalls via `/lib/process`: `open`, `read`, `write`, `close`, etc.
- Standard fds: 0=stdin, 1=stdout, 2=stderr
- Signal handling via `onSignal()` callback
- Must call `exit(code)` at end

### Key Patterns for Conversion
```typescript
// Old pattern
io.stdout.write('text\n');
io.stderr.write('error\n');
const data = await fs.read(path);

// New pattern
await println('text');         // or write(1, encoder.encode('text\n'))
await eprintln('error');       // or write(2, encoder.encode('error\n'))
const fd = await open(path, { read: true });
const data = await read(fd, size);
await close(fd);
```

---

## Status Legend
- [ ] Not started
- [~] In progress
- [x] Complete
- [-] Skip (not needed for core OS)
- [!] Problem/blocked

---

## Already Converted (rom/bin/)

| Command | Notes |
|---------|-------|
| cat | File concatenation |
| cd | Change directory (shell built-in) |
| echo | Output text |
| ls | List directory |
| mkdir | Create directory |
| pwd | Print working directory |
| rm | Remove files |
| rmdir | Remove directories |
| touch | Create/update file timestamp |

---

## Phase 1: Trivial Commands

Commands with minimal logic, easy to convert first.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| true | [x] | none | Exit 0 |
| false | [x] | none | Exit 1 |

---

## Phase 2: Simple Commands

Single-purpose commands with straightforward logic.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| yes | [x] | [string] | Output string repeatedly |
| seq | [x] | [-s sep] [-w] first [incr] last | Print number sequence |
| sleep | [x] | duration | Delay for specified time |
| basename | [x] | [-a] [-s suffix] path... | Strip directory from path |
| dirname | [x] | path... | Strip filename from path |

---

## Phase 3: Text Processing (stdin/file -> stdout)

Line-oriented text processing commands.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| head | [x] | [-n N] [file] | Output first N lines |
| tail | [x] | [-n N] [file] | Output last N lines |
| wc | [x] | [-lwc] [file] | Count lines/words/chars |
| nl | [x] | [-bntw] [file] | Number lines |

---

## Phase 4: File Information

Commands that report file metadata.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| stat | [ ] | file... | Display file status |
| file | [ ] | file... | Determine file type |
| readlink | [ ] | [-f] link... | Print symlink target |
| realpath | [ ] | path... | Print resolved path |
| du | [ ] | [-sh] [path...] | Disk usage |
| df | [ ] | [-h] | Filesystem space |

---

## Phase 5: Text Filters

More complex text transformation commands.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| sort | [x] | [-rnufbdhktos] [file...] | Sort lines |
| uniq | [x] | [-cdui] [file] | Filter adjacent duplicates |
| tr | [x] | [-ds] set1 [set2] | Translate characters |
| cut | [x] | -d delim -f fields [file] | Cut columns |
| grep | [ ] | [-invrclHh] pattern [file...] | Search patterns |

---

## Phase 6: File Operations

Commands that modify files.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| cp | [x] | [-r] src... dest | Copy files |
| mv | [x] | src... dest | Move/rename files |
| ln | [x] | [-s] target link | Create links (returns EPERM - disabled) |
| chmod | [x] | mode file... | Returns EPERM (use 'grant' instead) |
| tee | [x] | [-a] file... | Duplicate to files |
| mktemp | [ ] | [-d] [template] | Create temp file/dir |

---

## Phase 7: System Utilities

Environment and system information.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| env | [!] | [name=val...] [cmd] | Print/set environment (needs listenv syscall) |
| date | [x] | [+format] | Print date/time |
| uname | [x] | [-amnrsvo] | System information |
| whoami | [x] | none | Print current user |
| printf | [x] | format [args...] | Formatted output |

---

## Phase 8: Complex Commands

Multi-feature commands requiring careful implementation.

| Command | Status | Args | Description |
|---------|--------|------|-------------|
| find | [ ] | path [-name/-type/-exec] | Find files |
| tree | [ ] | [-L level] [path] | Directory tree |
| xargs | [ ] | [-n N] cmd [args] | Build command lines |
| diff | [ ] | file1 file2 | Compare files |
| sed | [ ] | script [file] | Stream editor |
| test | [ ] | expression | Conditional test |

---

## Skip: Monk-Specific Commands

These commands are specific to the Monk API layer and don't belong in core OS.

| Command | Reason |
|---------|--------|
| select, aggregate, describe, introspect | Database query |
| query, insert, update, delete, count | CRUD operations |
| insert_bulk, update_bulk, delete_bulk | Bulk operations |
| dump, restore | Data backup |
| curl | HTTP client (use network syscalls) |
| stm, ltm, coalesce | AI memory |
| ai, glow | AI integration |
| git | Git operations (subcommand group) |
| keys | Key management (subcommand group) |

---

## Skip: Shell Built-ins

These are handled by the shell itself, not as separate binaries.

| Command | Reason |
|---------|--------|
| if, then, else, elif, fi | Control flow |
| source, . | Script execution |
| export | Environment (shell manages env) |
| history | Shell history |
| clear | Terminal control |
| help, man | Documentation |
| debug | Debug mode |
| exit, logout, quit | Shell exit |

---

## Skip: Need Special Handling

Commands that need kernel/HAL features not yet available.

| Command | Blocker |
|---------|---------|
| mount, umount | VFS mount syscalls |
| passwd | User management |
| ps, kill | Process table access |
| timeout, time, watch | Process spawning + timing |
| ping | ICMP/network |
| nc | Raw sockets |
| awk, jq | Complex parsers (large) |
| free | Memory stats (HAL) |
| which | PATH search |

---

## Completed Complex Commands

| Command | Status | Notes |
|---------|--------|-------|
| awk | [x] | Full implementation: lexer, parser, interpreter |
| sed | [x] | Stream editor with s/d/p/q/a/i/c/y commands |

---

## Implementation Notes

### Signal Handling
```typescript
import { onSignal, SIGTERM } from '/lib/process';

onSignal((signal) => {
    if (signal === SIGTERM) {
        // cleanup
        exit(130);
    }
});
```

### Reading stdin
```typescript
// Read all stdin
while (true) {
    const chunk = await read(0, 4096);
    if (chunk.length === 0) break;
    // process chunk
}

// Or use BufferedReader for lines
import { BufferedReader } from '/lib/io';
const reader = new BufferedReader(0);
let line: string | null;
while ((line = await reader.readLine()) !== null) {
    // process line
}
```

### Error Handling
```typescript
try {
    const fd = await open(path, { read: true });
    // ...
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await eprintln(`cmd: ${file}: ${msg}`);
    await exit(1);
}
```

### Path Resolution
```typescript
import { resolvePath } from '/lib/shell';
const cwd = await getcwd();
const resolved = resolvePath(cwd, userPath);
```

---

## Conversion Checklist

For each command:
1. [ ] Read original implementation
2. [ ] Document args in header comment
3. [ ] Handle stdin if applicable
4. [ ] Handle multiple files if applicable
5. [ ] Proper error messages to stderr
6. [ ] Proper exit codes
7. [ ] Signal handling for long-running
8. [ ] No fs object access (use syscalls)
