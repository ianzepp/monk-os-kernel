# Syscall Reference

All syscalls follow the `domain:verb` naming convention.

## Process (`proc:*`)

| Syscall | Description |
|---------|-------------|
| `proc:spawn` | Create a child process |
| `proc:exit` | Terminate the calling process |
| `proc:kill` | Send a signal to a process |
| `proc:wait` | Wait for a child process to exit |
| `proc:getpid` | Get calling process ID |
| `proc:getppid` | Get parent process ID |
| `proc:getargs` | Get command-line arguments |
| `proc:getcwd` | Get current working directory |
| `proc:chdir` | Change current working directory |
| `proc:getenv` | Get environment variable |
| `proc:setenv` | Set environment variable |

## File (`file:*`)

| Syscall | Description |
|---------|-------------|
| `file:open` | Open a file |
| `file:close` | Close a file descriptor |
| `file:read` | Read from a file descriptor |
| `file:write` | Write to a file descriptor |
| `file:seek` | Seek to position in file |
| `file:stat` | Get file metadata by path |
| `file:fstat` | Get file metadata by descriptor |
| `file:mkdir` | Create a directory |
| `file:unlink` | Delete a file |
| `file:rmdir` | Delete a directory |
| `file:readdir` | List directory contents |
| `file:rename` | Rename/move a file or directory |
| `file:symlink` | Create a symbolic link |
| `file:access` | Get/set access control list |
| `file:recv` | Receive message from file descriptor |
| `file:send` | Send message to file descriptor |

## Filesystem (`fs:*`)

| Syscall | Description |
|---------|-------------|
| `fs:mount` | Mount a filesystem |
| `fs:umount` | Unmount a filesystem |

## Network (`net:*`)

| Syscall | Description |
|---------|-------------|
| `net:connect` | Connect to a remote host |

## Port (`port:*`)

| Syscall | Description |
|---------|-------------|
| `port:create` | Create a port (tcp:listen, udp:bind, fs:watch, pubsub:subscribe) |
| `port:close` | Close a port |
| `port:recv` | Receive message from port |
| `port:send` | Send message on port |

### Port Types

| Type | Options | Description |
|------|---------|-------------|
| `tcp:listen` | `{ port, host?, backlog? }` | TCP listener |
| `udp:bind` | `{ port, host? }` | UDP socket |
| `fs:watch` | `{ pattern }` | Filesystem watcher |
| `pubsub:subscribe` | `{ topics }` | Pub/sub subscription |
| `signal:catch` | `{ signals }` | Signal handler (future) |
| `proc:watch` | `{ scope }` | Process watcher (future) |

## Channel (`channel:*`)

| Syscall | Description |
|---------|-------------|
| `channel:open` | Open a protocol channel (http, ws, postgres, sqlite) |
| `channel:close` | Close a channel |
| `channel:call` | Send request, receive single response |
| `channel:stream` | Send request, iterate streaming responses |
| `channel:push` | Push response to client (server channels) |
| `channel:recv` | Receive message from remote |

## Handle (`handle:*`)

| Syscall | Description |
|---------|-------------|
| `handle:redirect` | Redirect a file descriptor |
| `handle:restore` | Restore a redirected descriptor |
| `handle:send` | Send message through handle |
| `handle:close` | Close a handle |

## IPC (`ipc:*`)

| Syscall | Description |
|---------|-------------|
| `ipc:pipe` | Create a unidirectional pipe |

## Worker (`worker:*`)

| Syscall | Description |
|---------|-------------|
| `worker:load` | Load script into leased worker |
| `worker:send` | Send message to worker |
| `worker:recv` | Receive message from worker |
| `worker:release` | Release leased worker |

## Pool (`pool:*`)

| Syscall | Description |
|---------|-------------|
| `pool:lease` | Lease a worker from pool |
| `pool:stats` | Get pool statistics |

## Service (`activation:*`)

| Syscall | Description |
|---------|-------------|
| `activation:get` | Get service activation message |
