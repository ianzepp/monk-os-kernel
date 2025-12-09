# VFS Module

The Virtual File System provides a unified interface for file and directory operations, implementing Plan 9's "everything is a file" philosophy with BeOS-style queryable entities. VFS operations are exposed as `file:*` syscalls (for file/directory operations) and `fs:*` syscalls (for mount operations).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Syscall Layer (file:open, file:read, file:write, etc.)     │
├─────────────────────────────────────────────────────────────┤
│  VFS Class (path resolution, mount table, access control)   │
├─────────────────────────────────────────────────────────────┤
│  Models (FileModel, FolderModel, DeviceModel, LinkModel)    │
├─────────────────────────────────────────────────────────────┤
│  PathCache (in-memory O(1) path resolution)                 │
├─────────────────────────────────────────────────────────────┤
│  Storage Backends                                           │
│  ├── EMS (entities + detail tables for files/folders)       │
│  ├── HAL KV (virtual devices and links)                     │
│  └── Synthetic Mounts (proc, entity, host)                  │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/vfs/
├── index.ts              # Public API exports
├── vfs.ts                # Core VFS class (path resolution, mounts)
├── model.ts              # Model interface & PosixModel base class
├── handle.ts             # FileHandle interface & open flags
├── acl.ts                # Access Control List system
├── message.ts            # VFS message type definitions
├── path-cache.ts         # In-memory path resolution cache
├── models/
│   ├── entity.ts         # EntityModel (polymorphic EMS-backed)
│   ├── file.ts           # FileModel (extends EntityModel)
│   ├── folder.ts         # FolderModel (extends EntityModel)
│   ├── device.ts         # DeviceModel (virtual /dev devices)
│   └── link.ts           # LinkModel (symbolic links, disabled)
└── mounts/
    ├── host.ts           # HostMount (bridge to host filesystem)
    ├── proc.ts           # ProcMount (synthetic /proc)
    └── entity.ts         # EntityMount (entity data as filesystem)
```

## Core Concepts

### Two-Table Architecture

VFS entities use a split storage model:

1. **entities table**: Identity and hierarchy (id, model, parent, pathname)
2. **Detail tables**: Model-specific fields (file, folder, video, user, etc.)

**PathCache** indexes the entities table in memory for O(1) path resolution without SQL queries.

### Models

Models define behavior for entity classes. Each implements the `Model` interface:

| Model | Storage | Description |
|-------|---------|-------------|
| `EntityModel` | EMS (entities + detail) | Generic polymorphic model for all EMS entities |
| `FileModel` | EMS (extends EntityModel) | Files with blob storage (model='file') |
| `FolderModel` | EMS (extends EntityModel) | Directories (model='folder') |
| `DeviceModel` | HAL KV | Virtual devices (/dev/null, /dev/random, etc.) |
| `LinkModel` | HAL KV | Symbolic links (currently disabled) |

**Model Interface:**
```typescript
abstract class PosixModel {
    abstract open(ctx, id, flags): Promise<FileHandle>;
    abstract stat(ctx, id): Promise<ModelStat>;
    abstract setstat(ctx, id, fields): Promise<void>;
    abstract create(ctx, parent, name, fields?): Promise<string>;
    abstract unlink(ctx, id): Promise<void>;
    abstract list(ctx, id): AsyncIterable<string>;
    watch?(ctx, id, pattern?): AsyncIterable<WatchEvent>;
}
```

### PathCache

In-memory index for fast path resolution:

```
resolvePath("/home/user/docs/report.pdf")
    │
    ├─ childIndex.get("root:home")     → uuid-A
    ├─ childIndex.get("uuid-A:user")   → uuid-B
    ├─ childIndex.get("uuid-B:docs")   → uuid-C
    └─ childIndex.get("uuid-C:report") → uuid-D

4 Map lookups, zero SQL queries
```

Stores ~250 bytes per entity. For 1 million entities: ~250-300 MB RAM.

### Mount Types

**VFS Native Mounts** (Model-backed):
- Root filesystem backed by EMS
- Storage: entities table + detail tables
- PathCache provides O(1) path lookups

**Host Mounts** (filesystem bridge):
- Maps VFS path prefix to host directory
- Read-only by default for security
- Path traversal protected via boundary checking

**Proc Mounts** (kernel process information):
- Dynamic `/proc` from ProcessTable
- Paths: `/proc/{uuid}/stat`, `/proc/{uuid}/env`, `/proc/{uuid}/fd/`
- `/proc/self` resolves to caller's process

**Entity Mounts** (EMS data as files):
- Exposes entity records as directory structures
- Path: `/mount/{model}/{key}/fields/{field-name}`

### FileHandle

Capability-based I/O interface representing an open file.

```typescript
interface FileHandle {
    readonly id: string;
    readonly path: string;
    readonly flags: OpenFlags;
    readonly closed: boolean;
    read(size?): Promise<Uint8Array>;
    write(data): Promise<number>;
    seek(offset, whence): Promise<number>;
    tell(): Promise<number>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
```

Handles are capabilities - permissions are checked at `open()` time, then the handle grants access.

### Access Control (ACL)

Grant-based permission system:

- Explicit grants with principal, operations, and optional expiration
- Deny list for revocation (takes precedence over grants)
- Wildcard `*` for any principal or operation
- Kernel bypasses ACL checks (`caller === 'kernel'`)
- Default: owner gets full control, world gets read/stat access

### Standard Devices

Located at `/dev/`:

| Device | Description |
|--------|-------------|
| `/dev/null` | Discards all writes, reads return EOF |
| `/dev/zero` | Reads return zero bytes |
| `/dev/random` | Cryptographically secure random bytes |
| `/dev/urandom` | Alias for /dev/random |
| `/dev/console` | Host console (stdin/stdout) |
| `/dev/clock` | System clock reads |
| `/dev/gzip` | Gzip compression stream |
| `/dev/gunzip` | Gzip decompression stream |
| `/dev/deflate` | Deflate compression stream |
| `/dev/inflate` | Deflate decompression stream |

## Path Resolution

1. Normalize path (handle `.`, `..`, ensure leading `/`)
2. Check entity mounts (longest prefix match)
3. Check proc mount
4. Check PathCache for VFS entities (O(1) lookup)
5. Fall back to host mounts if not in VFS

**Storage Keys:**
- `entity:{uuid}` - JSON ModelStat (HAL entities only)
- `access:{uuid}` - JSON-encoded ACL
- `child:{parent}:{name}` - Child UUID (HAL index for devices/links)
- `data:{uuid}` - File content blob

**EMS Entities:**
- Stored in `entities` table + detail table
- PathCache provides O(1) resolution
- No HAL entity storage needed

## Syscall Reference

### File Descriptor Operations

#### `file:open`

Open a file or directory and return a file descriptor.

```typescript
const fd = await os.vfs<number>('open', '/path/to/file', flags);
```

**Parameters:**
- `path: string` - File or directory path
- `flags?: OpenFlags` - Open mode flags (default: `{ read: true }`)

**OpenFlags:**
```typescript
interface OpenFlags {
    read?: boolean;    // Open for reading
    write?: boolean;   // Open for writing
    append?: boolean;  // Append mode (writes go to end)
    truncate?: boolean; // Truncate file on open
    create?: boolean;  // Create if doesn't exist
    exclusive?: boolean; // Fail if exists (with create)
}
```

**Returns:** `number` - File descriptor

**Errors:**
- `ENOENT` - File not found
- `EACCES` - Permission denied
- `EISDIR` - Is a directory (when writing)

---

#### `file:close`

Close a file descriptor and release resources.

```typescript
await os.vfs('close', fd);
```

**Parameters:**
- `fd: number` - File descriptor to close

**Errors:**
- `EBADF` - Bad file descriptor

---

### Read/Write Operations

#### `file:read`

Read bytes from a file descriptor. Returns data chunks until EOF.

```typescript
const chunks = await os.syscall<Uint8Array[]>('file:read', fd);
```

**Parameters:**
- `fd: number` - File descriptor
- `chunkSize?: number` - Optional chunk size for partial reads

**Returns:** Stream of `Uint8Array` chunks (collected as array by `os.syscall`)

**Errors:**
- `EBADF` - Bad file descriptor
- `EACCES` - Not opened for reading

---

#### `file:write`

Write bytes to a file descriptor.

```typescript
await os.vfs('write', fd, data);
```

**Parameters:**
- `fd: number` - File descriptor
- `data: Uint8Array | string` - Data to write

**Returns:** Number of bytes written

**Errors:**
- `EBADF` - Bad file descriptor
- `EACCES` - Not opened for writing

---

#### `file:seek`

Seek to a position in a file. Only valid for file handles (not sockets/pipes).

```typescript
const newPos = await os.vfs<number>('seek', fd, offset, whence);
```

**Parameters:**
- `fd: number` - File descriptor
- `offset: number` - Byte offset
- `whence: 'start' | 'current' | 'end'` - Reference point (default: `'start'`)

**Returns:** New absolute position

**Errors:**
- `EBADF` - Bad file descriptor
- `EINVAL` - Invalid seek on socket/pipe
- `ENOTSUP` - Seek not supported (devices)

---

### Metadata Operations

#### `file:stat`

Get file or directory metadata by path.

```typescript
const stat = await os.vfs<Stat>('stat', '/path/to/file');
```

**Parameters:**
- `path: string` - File or directory path

**Returns:**
```typescript
interface Stat {
    id: string;        // Entity UUID
    name: string;      // Base name
    parent: string | null; // Parent UUID
    model: string;     // Model type
    owner: string;     // Owner UUID
    size: number;      // Size in bytes
    mtime: number;     // Last modified (ms since epoch)
    ctime: number;     // Created (ms since epoch)
}
```

**Errors:**
- `ENOENT` - Path not found

---

#### `file:fstat`

Get file metadata by file descriptor. Avoids path resolution (no TOCTOU issues).

```typescript
const stat = await os.vfs<Stat>('fstat', fd);
```

**Parameters:**
- `fd: number` - File descriptor

**Returns:** Same as `file:stat`

**Errors:**
- `EBADF` - Bad file descriptor

---

### Directory Operations

#### `file:mkdir`

Create a directory.

```typescript
await os.vfs('mkdir', '/path/to/dir');
await os.vfs('mkdir', '/path/to/deep/dir', { recursive: true });
```

**Parameters:**
- `path: string` - Directory path to create
- `opts?: { recursive?: boolean }` - Create parent directories if needed

**Errors:**
- `EEXIST` - Directory already exists
- `ENOENT` - Parent directory not found (without `recursive`)
- `ENOTDIR` - Parent is not a directory
- `EACCES` - Permission denied

---

#### `file:readdir`

List directory contents. Returns entries as a stream.

```typescript
const entries = await os.vfs<string[]>('readdir', '/path/to/dir');
```

**Parameters:**
- `path: string` - Directory path

**Returns:** Array of entry names (collected from stream)

**Errors:**
- `ENOENT` - Directory not found
- `ENOTDIR` - Not a directory
- `EFBIG` - Too many entries (exceeds limit)

---

#### `file:unlink`

Remove a file or symbolic link.

```typescript
await os.vfs('unlink', '/path/to/file');
```

**Parameters:**
- `path: string` - Path to remove

**Errors:**
- `ENOENT` - File not found
- `EISDIR` - Is a directory (use `rmdir`)
- `EACCES` - Permission denied

---

#### `file:rmdir`

Remove a directory.

```typescript
await os.vfs('rmdir', '/path/to/dir');
```

**Parameters:**
- `path: string` - Directory path to remove

**Errors:**
- `ENOENT` - Directory not found
- `ENOTEMPTY` - Directory not empty
- `EACCES` - Permission denied

---

### Symbolic Links

#### `file:symlink`

Create a symbolic link.

**Status:** Currently disabled - throws `EPERM`

```typescript
await os.vfs('symlink', '/target/path', '/link/path');
```

**Parameters:**
- `target: string` - Path the symlink points to
- `linkPath: string` - Path where symlink is created

**Errors:**
- `EPERM` - Symbolic links are not supported

---

#### `file:readlink`

Read the target of a symbolic link.

```typescript
const target = await os.vfs<string>('readlink', '/path/to/link');
```

**Parameters:**
- `path: string` - Link path

**Returns:** Target path string

**Errors:**
- `ENOENT` - Link not found or not a symlink

---

### Access Control

#### `file:access`

Get or set access control list (ACL) for a path.

```typescript
// Get ACL
const acl = await os.vfs<ACL>('access', '/path/to/file');

// Set ACL
await os.vfs('access', '/path/to/file', {
    grants: [
        { to: 'user-uuid', ops: ['read', 'write'] },
        { to: '*', ops: ['read'] }
    ],
    deny: []
});

// Clear ACL (restore defaults)
await os.vfs('access', '/path/to/file', null);
```

**Parameters:**
- `path: string` - File or directory path
- `acl?: ACL | null` - ACL to set (omit to get, null to clear)

**Returns:** Current ACL (when getting)

**Errors:**
- `ENOENT` - Path not found
- `EACCES` - Permission denied

---

### Mount Operations

These syscalls use `fs:` prefix (not `file:`) and are subject to mount policy rules.

#### `fs:mount`

Mount a filesystem to a target path.

```typescript
// Mount host directory
await os.syscall('fs:mount', 'host:/path/on/host', '/mnt/data');

// With options
await os.syscall('fs:mount', 'host:./src', '/app', { readonly: true });
```

**Parameters:**
- `source: string` - Mount source with type prefix
- `target: string` - Target path in VFS (absolute)
- `opts?: object` - Mount-specific options

**Mount Sources:**
| Prefix | Description | Example |
|--------|-------------|---------|
| `host:` | Host filesystem directory | `host:/home/user/data` |

**Errors:**
- `EPERM` - Mount policy denies operation
- `EACCES` - Missing required grant on target
- `EINVAL` - Unknown mount source type

---

#### `fs:umount`

Unmount a filesystem.

```typescript
await os.syscall('fs:umount', '/mnt/data');
```

**Parameters:**
- `target: string` - Path to unmount

**Errors:**
- `EPERM` - Mount policy denies operation
- `EINVAL` - Target not mounted

---

### Message-Based I/O

These syscalls are used for stdin/stdout/stderr (MessagePipe handles) and sockets.

#### `file:recv`

Receive messages from a file descriptor.

```typescript
for await (const response of os.syscallStream('file:recv', fd)) {
    if (response.op === 'data') {
        // Handle message
    }
}
```

**Parameters:**
- `fd: number` - File descriptor

**Returns:** Stream of Response messages

---

#### `file:send`

Send a message to a file descriptor.

```typescript
await os.vfs('send', fd, { op: 'data', bytes: new Uint8Array([...]) });
```

**Parameters:**
- `fd: number` - File descriptor
- `msg: Response` - Message to send

---

## Convenience Helpers

The OS class provides high-level helpers that wrap these syscalls:

```typescript
// Read file as bytes (handles open/read/close)
const bytes = await os.read('/path/to/file');

// Read file as text
const text = await os.text('/path/to/file');
const utf16 = await os.text('/path/to/file', 'utf-16');
```

## Error Codes

| Code | Description |
|------|-------------|
| `ENOENT` | No such file or directory |
| `EEXIST` | File or directory already exists |
| `EACCES` | Permission denied |
| `EBADF` | Bad file descriptor |
| `EINVAL` | Invalid argument |
| `EISDIR` | Is a directory |
| `ENOTDIR` | Not a directory |
| `ENOTEMPTY` | Directory not empty |
| `EFBIG` | File or listing too large |
| `ENOSYS` | Function not implemented |
| `ENOTSUP` | Operation not supported |
| `EPERM` | Operation not permitted |

## Examples

### Read and Parse JSON

```typescript
const fd = await os.vfs<number>('open', '/etc/config.json', { read: true });
const chunks = await os.syscall<Uint8Array[]>('file:read', fd);
await os.vfs('close', fd);

const text = new TextDecoder().decode(chunks[0]);
const config = JSON.parse(text);

// Or use the helper:
const config = JSON.parse(await os.text('/etc/config.json'));
```

### Write a File

```typescript
const fd = await os.vfs<number>('open', '/tmp/output.txt', {
    write: true,
    create: true,
    truncate: true
});
await os.vfs('write', fd, new TextEncoder().encode('Hello, World!'));
await os.vfs('close', fd);
```

### List and Filter Directory

```typescript
const entries = await os.vfs<string[]>('readdir', '/etc');
const jsonFiles = entries.filter(name => name.endsWith('.json'));

for (const name of jsonFiles) {
    const stat = await os.vfs<Stat>('stat', `/etc/${name}`);
    console.log(`${name}: ${stat.size} bytes`);
}
```

### Create Directory Structure

```typescript
// Create nested directories
await os.vfs('mkdir', '/app/data/cache', { recursive: true });

// Write files into it
const fd = await os.vfs<number>('open', '/app/data/cache/index.json', {
    write: true,
    create: true,
});
await os.vfs('write', fd, new TextEncoder().encode('{}'));
await os.vfs('close', fd);
```
