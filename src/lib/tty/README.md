# TTY System

A Linux-like terminal interface for Monk, providing shell access over Telnet and SSH.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Transport Layer                         │
│  ┌─────────────────┐          ┌─────────────────┐          │
│  │  Telnet Server  │          │   SSH Server    │          │
│  │  (port 2323)    │          │   (port 2222)   │          │
│  └────────┬────────┘          └────────┬────────┘          │
│           │                            │                    │
│           └──────────┬─────────────────┘                    │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Session Handler                         │   │
│  │  - Authentication state machine                      │   │
│  │  - Command parsing and dispatch                      │   │
│  │  - Pipeline execution (pipes, redirects)             │   │
│  │  - Background process spawning                       │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  Commands                            │   │
│  │  ls, cd, cat, ping, ps, kill, select, describe...   │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Virtual Filesystem                      │   │
│  │  /api/data, /api/describe, /proc, /home, /tmp...    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Files

| File | Description |
|------|-------------|
| `types.ts` | Core interfaces: Session, TTYStream, CommandIO, ParsedCommand |
| `session-handler.ts` | Authentication, command execution, pipeline handling |
| `parser.ts` | Command parsing, variable expansion, path resolution |
| `commands.ts` | Re-exports from commands/ directory |
| `commands/*.ts` | Individual command implementations |
| `man/*` | Manual pages for commands |

## Session Lifecycle

1. **Connection** - Telnet/SSH server creates a `Session` object
2. **Authentication** - State machine: `AWAITING_USERNAME` → `AWAITING_PASSWORD` → `AUTHENTICATED`
3. **Shell Process** - On login, a `monksh` daemon process is registered (visible in `ps`)
4. **Command Loop** - Parse input, execute commands, print prompt
5. **Disconnect** - On `exit`, CTRL+D, or connection drop, shell process is terminated

## Commands

### Navigation
- `pwd` - Print working directory
- `cd <path>` - Change directory

### Filesystem
- `ls [-1laRhStrd] [path]` - List directory contents
- `tree [-dL] [path]` - Display directory tree
- `cat <file>` - Display file contents
- `head [-n N] [file]` - Show first N lines
- `tail [-n N] [file]` - Show last N lines
- `touch <file>` - Create empty file
- `mkdir <dir>` - Create directory
- `rm [-rf] <file>` - Remove file or directory
- `rmdir <dir>` - Remove empty directory
- `mv <src> <dst>` - Move/rename
- `cp [-r] <src> <dst>` - Copy files/directories
- `ln -s <target> <link>` - Create symbolic link
- `chmod <mode> <file>` - Change file permissions
- `find [path] [-name|-iname|-path] [-exec|-delete|-print0]` - Find files
- `file [-i] <path>` - Determine file type
- `stat [-ct] <file>` - Display file status
- `readlink [-fem] <link>` - Print symlink target
- `realpath [--relative-to] <path>` - Resolve absolute pathname
- `mktemp [-dp] [template]` - Create temporary file/directory
- `du [-shd] [path]` - Estimate file space usage
- `df [-hTt] [path]` - Report filesystem disk space

### Mounts
- `mount` - List mounted filesystems
- `mount -t local <src> <dst>` - Mount host directory
- `umount <path>` - Unmount filesystem

### Data Operations
- `select <fields> [from <path>]` - Query records with field selection
- `describe <model>` - Show model schema
- `insert <collection> [json]` - Create record(s)
- `update <record> [json]` - Update a record
- `delete <record>...` - Delete record(s)
- `count [path]` - Count records in collection
- `dump <path> [models...]` - Export to SQLite file
- `restore <path> [models...]` - Import from SQLite file
- `curl [options] <url>` - HTTP requests (internal/external)
- `nc [-zv] <host> <port>` - TCP connections (netcat)

### Process Management
- `ps [-a]` - List processes (`-a` includes dead/zombie)
- `kill <pid>` - Terminate a process
- `ping [-c N] [-i S] <target>` - HTTP ping (local API or external URL)
- `sleep <duration>` - Pause execution
- `timeout <duration> <cmd>` - Run command with timeout

### Text Processing
- `grep [-ivFwxcnloqm] <pattern>` - Filter lines by regex
- `sed [-nEri] <script>` - Stream editor
- `awk [-F fs] [-v var=val] 'program'` - Pattern scanning and text processing
- `sort [-rnufbdhk] [-t delim]` - Sort lines
- `uniq [-cd]` - Filter adjacent duplicate lines
- `wc [-lwc]` - Word, line, character count
- `cut -d<delim> -f<fields>` - Extract fields
- `tr <set1> <set2>` - Translate characters
- `jq <filter>` - JSON processing
- `printf <format> [args...]` - Format and print data
- `diff [-uyiwB] <file1> <file2>` - Compare files line by line

### Environment
- `echo <text>` - Print text (supports $VAR expansion)
- `env` - Show environment variables
- `export VAR=value` - Set environment variable
- `whoami` - Show current user
- `passwd [user]` - Change password
- `date [-uI] [+format]` - Show date/time
- `history [-c] [N]` - Show command history
- `uname [-asnrvmo]` - Print system information
- `free [-hbkmgt]` - Display memory usage

### Utilities
- `xargs [-0dIntrLP] <cmd>` - Build commands from stdin
- `tee [-a] <file>` - Write to stdout and file
- `true` - Exit with success (0)
- `false` - Exit with failure (1)
- `seq [first] [incr] <last>` - Print number sequence
- `yes [string]` - Output string repeatedly until killed
- `which <cmd>` - Locate a command
- `time [-pv] <cmd>` - Measure command execution time
- `watch [-nde] <cmd>` - Execute command periodically

### Scripting
- `source <file>` / `. <file>` - Execute commands from file
- `test <expr>` / `[ <expr> ]` - Evaluate conditional expression
- `read [-rp] <var>...` - Read line from stdin into variables
- `basename <path> [suffix]` - Strip directory from filename
- `dirname <path>` - Strip filename from path

### Hashing
- `md5sum [file...]` - Compute MD5 hash
- `shasum [-a algo] [file...]` - Compute SHA hash (1, 256, 384, 512)

### Keys & Credentials
- `keys list [--type ssh|api]` - List registered keys
- `keys add ssh <pubkey>` - Add SSH public key
- `keys add api [--name <n>]` - Generate API key
- `keys remove <id>` - Remove a key
- `keys fingerprint <pubkey>` - Show SSH key fingerprint

### Version Control
- `git clone <url> [dest]` - Clone repository to /tmp

### AI Assistant
- `@` / `ai` - AI assistant (conversation mode when no args)
- `@ <prompt>` - One-shot question
- `<input> | @ <prompt>` - Ask about piped data
- `glow [file]` - Render markdown with terminal styling

### Session
- `help` - Show available commands
- `man <cmd>` - Show manual page
- `clear` - Clear screen
- `exit` / `logout` / `quit` - End session

## Pipes, Redirects, and Chaining

Standard shell syntax is supported:

```bash
# Pipes
cat /api/data/users | grep admin | jq .email

# Output redirect
select id, name from users > /tmp/users.txt

# Append redirect
echo "log entry" >> /var/log/app.log

# Input redirect
cat < /tmp/input.txt

# Tee (write to file and pass through)
find . | tee /tmp/files.txt | wc -l

# Command chaining with && (run next if previous succeeds)
mkdir /tmp/work && cd /tmp/work && echo "Ready"

# Command chaining with || (run next if previous fails)
cat /missing/file || echo "File not found"

# Combined chaining
test -f config.json && cat config.json || echo "No config"
```

## Scripting

Shell scripts can be executed with `source` or `.`:

```bash
# Create a script
cat > ~/setup.sh << 'EOF'
#!/bin/monksh
# Setup script
export API_URL=http://localhost:3000
export DEBUG=true
echo "Environment configured"
EOF

# Execute the script
source ~/setup.sh
# or
. ~/setup.sh

# Variables set in the script affect the current session
echo $API_URL
```

The `$?` variable contains the exit code of the last command:

```bash
cat /missing/file
echo $?    # prints 1

echo "hello"
echo $?    # prints 0
```

## Background Processes

Commands can be run in the background with `&`:

```bash
ping /health &
# [1] 42

ps
# Shows ping running with ppid pointing to your shell

kill 42
# Terminates the background process
```

Background process output is captured to `/tmp/.proc/{pid}/stdout` and `/tmp/.proc/{pid}/stderr`.

## Host Filesystem Mounts

Mount directories from the host system into the virtual filesystem:

```bash
# Mount a host directory (use absolute paths)
mount -t local /Users/me/projects /projects

# Mount read-only
mount -t local -r /var/log /logs

# List mounts
mount

# Unmount
umount /projects
```

Note: The `~` character expands to the virtual home directory, not the host home. Use absolute paths for host mounts.

## Process Table

The process system is modeled after Linux `/proc`:

| State | Meaning |
|-------|---------|
| R | Running |
| S | Sleeping |
| Z | Zombie (killed/crashed) |
| T | Stopped |
| X | Dead (exited normally) |

Process types:
- `daemon` - Shell sessions (monksh)
- `command` - Background commands
- `script` - Script execution (future)
- `cron` - Scheduled jobs (future)

## /proc Filesystem

The process table is exposed as a virtual filesystem:

```bash
ls /proc
# 1/  5/  7/

cat /proc/7/status
# Name:    ping
# State:   R (running)
# Pid:     7
# PPid:    5
# ...

cat /proc/7/cmdline
# ping /health
```

## Signal Handling

- **CTRL+C** - Interrupts foreground command (if running) or clears input
- **CTRL+D** - Disconnects session

Commands must check `io.signal?.aborted` in loops to be interruptible:

```typescript
while (running) {
    if (io.signal?.aborted) break;
    // ... do work
}
```

## Variable Expansion

The parser supports shell-style variable expansion:

```bash
echo $USER              # Simple variable
echo ${HOME}            # Braced variable
echo ${FOO:-default}    # Variable with default
cd ~                    # Home directory
```

## Glob Expansion

Filename patterns are expanded before command execution:

```bash
ls *.txt                # All .txt files
cat /api/data/user*     # Files starting with "user"
rm /tmp/*.log           # All .log files in /tmp
echo config.?           # Single character wildcard
```

Supported patterns:
- `*` - matches any characters
- `?` - matches single character
- If no files match, the pattern is passed literally (bash behavior)

## Adding New Commands

1. Create `src/lib/tty/commands/mycommand.ts`:

```typescript
import type { CommandHandler } from './shared.js';

export const mycommand: CommandHandler = async (session, fs, args, io) => {
    // Check for abort signal in loops
    if (io.signal?.aborted) return 130;

    // Write output
    io.stdout.write('Hello\n');

    // Return exit code (0 = success)
    return 0;
};
```

2. Register in `src/lib/tty/commands/index.ts`:

```typescript
import { mycommand } from './mycommand.js';
// ... add to imports, exports, and commands registry
```

3. Optionally add a man page at `src/lib/tty/man/mycommand`

## Environment Variables

Set automatically on login:

| Variable | Description |
|----------|-------------|
| `USER` | Username |
| `TENANT` | Tenant name |
| `ACCESS` | Access level (root/full/edit/read) |
| `HOME` | Home directory (/home/{user}) |
| `TERM` | Terminal type (xterm) |
| `SHELL` | Shell path (/bin/monksh) |

## Configuration Files

- `~/.profile` - Executed on login (export commands, etc.)
- `~/.history` - Command history (persisted)

## Fixture Deployment

The TTY provides a powerful interface for deploying test data and fixtures via SSH.

### Setup

Mount a shared fixtures directory on the server:

```bash
# Mount fixtures from host filesystem
mount -t local /var/monk/fixtures /fixtures
```

### Deployment Scenarios

**Reset test environment:**
```bash
ssh monk@staging -p 2222
restore --replace /fixtures/e2e-test-data.db
```

**Deploy feature branch fixtures:**
```bash
restore /fixtures/feature-xyz.db users products
```

**Seed production with initial data:**
```bash
restore --skip /fixtures/seed.db  # only insert missing records
```

**Schema-only migration:**
```bash
restore -s /fixtures/schema-v3.db  # update schema, preserve data
```

### CI/CD Integration

```yaml
# GitLab CI example
deploy-fixtures:
  stage: deploy
  script:
    - ssh monk@$HOST -p 2222 "restore --replace /fixtures/${CI_COMMIT_REF_SLUG}.db"

create-fixture:
  stage: build
  script:
    - ssh monk@$HOST -p 2222 "dump /fixtures/${CI_COMMIT_REF_SLUG}.db"
```

### Dump/Restore Options

**dump:**
```bash
dump <path> [models...]     # Export to SQLite
dump -s <path>              # Schema only
dump -d <path>              # Data only
dump --strip-access <path>  # Remove ACL fields (for fixtures)
```

**restore:**
```bash
restore <path> [models...]  # Import (upsert by default)
restore --replace <path>    # Delete existing, then import
restore --skip <path>       # Skip existing records
restore --merge <path>      # Only import new models
restore -s <path>           # Schema only
restore -d <path>           # Data only
```

## AI Assistant

The `@` command provides an AI assistant powered by Claude. Requires `ANTHROPIC_API_KEY` environment variable on the server.

### One-Shot Mode

Ask a quick question or analyze piped data:

```bash
@ what time is it in Tokyo?
cat /api/data/users | @ summarize this data
select * from users | @ find users with admin role
@ list 10 unix commands | head -5
```

### Conversation Mode

Enter interactive mode where the AI can execute commands:

```bash
$ @
Entering AI conversation mode. Type "exit" or Ctrl+D to return to shell.

ai> what models are available?
[Running: describe users]
The system has a users model with fields: name, auth, access...

ai> how many users are there?
[Running: count /api/data/users]
There are 3 users in the system.

ai> exit
$
```

In conversation mode, the AI can:
- Explore the filesystem (`ls`, `cat`, `find`, `tree`)
- Query data (`select`, `describe`, `count`)
- Run utilities (`grep`, `wc`, `jq`)
- Modify files when asked (`touch`, `mkdir`, `rm`)

### Markdown Rendering

Pipe AI output through `glow` for styled terminal output:

```bash
@ explain docker in markdown | glow
```

## Foreground Process I/O

Interactive commands can read from stdin while the session handler manages input:

```typescript
export const myInteractiveCommand: CommandHandler = async (session, fs, args, io) => {
    io.stdout.write('Enter your name: ');

    // Read a line from stdin (session handler buffers and sends on Enter)
    for await (const chunk of io.stdin) {
        const name = chunk.toString().trim();
        io.stdout.write(`Hello, ${name}!\n`);
        break;
    }

    return 0;
};
```

The session tracks foreground I/O state:
- `session.foregroundIO.mode = 'line'` - Line-buffered input with editing
- `session.foregroundIO.mode = 'raw'` - Raw character-by-character input

When a foreground process is active:
- User input is piped to `foregroundIO.stdin`
- Process output goes to `foregroundIO.stdout/stderr`
- History navigation is disabled
- Escape sequences are forwarded to the process
