# Syscall Test Coverage

## Current State

Syscall unit tests are sparse. Most syscalls lack dedicated unit tests, relying instead on integration tests through shell commands or other higher-level tests.

## Coverage Summary

| Category | Tested | Missing |
|----------|--------|---------|
| **Channel** | channel:open, channel:call, channel:stream, channel:push, channel:recv, channel:close | - |
| **Network** | connect, port, port:close | recv, send |
| **Misc** | getcwd, chdir, getenv, setenv | getargs |
| **File** | close, read, write, stat | open, seek, fstat, mkdir, unlink, rmdir, readdir, rename, symlink, access |
| **Process** | - | spawn, exit, kill, wait, getpid, getppid |
| **Handle** | - | handle:send, handle:close, handle:redirect, handle:restore, pipe |
| **Worker** | - | pool:lease, pool:stats, worker:load, worker:send, worker:recv, worker:release |
| **Other** | - | activation:get |

## Complete Syscall List

### File Syscalls (`src/kernel/syscalls/file.ts`)
- `open` - Open file, return fd
- `close` - Close fd
- `read` - Read from fd
- `write` - Write to fd
- `seek` - Seek within file
- `stat` - Get file metadata by path
- `fstat` - Get file metadata by fd
- `mkdir` - Create directory
- `unlink` - Remove file
- `rmdir` - Remove directory
- `readdir` - List directory contents (streaming)
- `rename` - Rename file (ENOSYS - not implemented)
- `symlink` - Create symbolic link
- `access` - Get/set ACL

### Network Syscalls (`src/kernel/syscalls/network.ts`)
- `connect` - Connect to TCP/Unix socket
- `port` - Create port (tcp:listen, watch, udp, pubsub)
- `recv` - Receive from port
- `send` - Send to port
- `port:close` - Close port

### Misc Syscalls (`src/kernel/syscalls/misc.ts`)
- `getargs` - Get process arguments
- `getcwd` - Get current working directory
- `chdir` - Change working directory
- `getenv` - Get environment variable
- `setenv` - Set environment variable

### Channel Syscalls (`src/kernel/syscalls/channel.ts`)
- `channel:open` - Open channel to remote service
- `channel:call` - Send request, get single response
- `channel:stream` - Send request, stream responses
- `channel:push` - Push response (server-side)
- `channel:recv` - Receive message (bidirectional)
- `channel:close` - Close channel

### Process Syscalls (`src/kernel/kernel.ts`)
- `spawn` - Spawn child process
- `exit` - Exit current process
- `kill` - Send signal to process
- `wait` - Wait for child to exit
- `getpid` - Get current process ID
- `getppid` - Get parent process ID

### Handle Syscalls (`src/kernel/kernel.ts`)
- `handle:send` - Send message to handle
- `handle:close` - Close handle
- `handle:redirect` - Redirect fd to another fd
- `handle:restore` - Restore redirected fd
- `pipe` - Create pipe pair [readFd, writeFd]

### Worker Pool Syscalls (`src/kernel/kernel.ts`)
- `pool:lease` - Lease worker from pool
- `pool:stats` - Get pool statistics
- `worker:load` - Load script into worker
- `worker:send` - Send message to worker
- `worker:recv` - Receive message from worker
- `worker:release` - Release worker back to pool

### Activation Syscall (`src/kernel/kernel.ts`)
- `activation:get` - Get activation message for service handlers

## Test Files

- `spec/kernel/syscalls.test.ts` - SyscallDispatcher + misc syscalls
- `spec/kernel/network.test.ts` - Network syscalls
- `spec/kernel/channel-syscalls.test.ts` - Channel syscalls

## Recommendations

1. **File syscalls** - Create `spec/kernel/file-syscalls.test.ts` with unit tests for all file operations
2. **Process syscalls** - Create `spec/kernel/process-syscalls.test.ts` for spawn/exit/kill/wait/getpid/getppid
3. **Handle syscalls** - Create `spec/kernel/handle-syscalls.test.ts` for pipe, redirect, restore, handle:send/close
4. **Worker syscalls** - Create `spec/kernel/worker-syscalls.test.ts` for pool and worker operations
5. **Expand existing** - Add missing tests to network (recv, send) and misc (getargs)

## Priority

1. **High**: Process syscalls - core functionality
2. **High**: File syscalls - heavily used
3. **Medium**: Handle syscalls - pipe/redirect used by shell
4. **Medium**: Network recv/send - complete the network story
5. **Low**: Worker syscalls - newer feature, less critical path
