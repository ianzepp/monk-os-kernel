# Monk OS Scripting

## Philosophy

TypeScript is the native scripting language. No bash, no sh. TS everywhere.

Bun runs TypeScript directly - no visible compile step. The OS inherits this capability.

## File Extensions

| Extension | Meaning | Intent |
|-----------|---------|--------|
| `.ts` | TypeScript source | Library/module - imported by other code |
| `.sh` | TypeScript source | Script/process - executed directly |

Both are TypeScript. The extension signals intent:

```typescript
// /lib/utils.ts - meant to be imported
export function formatBytes(n: number): string { ... }

// /bin/cleanup.sh - meant to be executed
import { formatBytes } from '/lib/utils.ts';
const files = await readdir('/tmp');
```

This is **convention, not enforced**. The kernel executes both identically. But `.sh` communicates "run this" while `.ts` communicates "import this".

No `.js` files. No other scripting languages at the OS level.

## Script Structure

Scripts are just TypeScript files:

```typescript
// /bin/cleanup.sh

import { readdir, stat, unlink } from '@monk/process';

const files = await readdir('/tmp');
for (const f of files) {
  const info = await stat(`/tmp/${f}`);
  if (Date.now() - info.mtime > 86400_000) {
    await unlink(`/tmp/${f}`);
  }
}
```

No shebang needed. Everything is TypeScript, so there's no ambiguity about which interpreter to use.

## Code Types

All are `.ts` files. The difference is how they're used, not how they're marked:

| Type | Purpose | Example |
|------|---------|---------|
| Library | Imported by other code | `/lib/utils.ts` |
| Script | Executed, runs and exits | `/bin/cleanup.ts` |
| Process | Long-running, spawned as daemon | `/bin/httpd.ts` |

The kernel doesn't distinguish. It loads and executes. Behavior emerges from the code:

```typescript
// Script - does work, exits
const files = await readdir('/tmp');
await cleanup(files);
// (implicit exit)

// Process - loops forever
const listener = await port('tcp:listen', { port: 8080 });
for await (const conn of listener) {
  handleConnection(conn);
}
// (never exits)
```

## Syscall Availability

### Globals

Common syscalls are available globally in scripts:

```typescript
// No import needed for common operations
const files = await readdir('/home');
const data = await read('/etc/config');
await write('/tmp/output', result);
```

### Imports

Less common syscalls require explicit import:

```typescript
import { port, connect, spawn } from '@monk/process';

const listener = await port('tcp:listen', { port: 8080 });
```

**TBD:** Exact split between global and imported syscalls. Likely globals:
- `read`, `write`, `open`, `close`
- `stat`, `readdir`, `mkdir`, `unlink`
- `getcwd`, `chdir`

Likely imports:
- `spawn`, `kill`, `wait`, `exit`
- `port`, `send`, `recv`, `connect`
- `access`, `chmod`

## Interactive Shell (REPL)

The shell is a TypeScript REPL with syscalls in scope:

```
$ const files = await readdir('/home')
['user', 'guest']

$ files.filter(f => f.startsWith('u'))
['user']

$ await unlink('/tmp/junk')
undefined

$ for (const f of await readdir('/tmp')) {
    console.log(await stat(`/tmp/${f}`))
  }
{ size: 1024, mtime: ... }
{ size: 2048, mtime: ... }

$ await spawn('/bin/httpd.ts')
42
```

Top-level await is supported (Bun handles this).

## Dynamic Execution

AI and other tools need to execute dynamically generated TypeScript.

### Options (TBD)

| Method | Description |
|--------|-------------|
| Temp file + spawn | Write to `/tmp/xxx.ts`, spawn, delete |
| Blob import | `import(URL.createObjectURL(blob))` |
| `exec` syscall | Kernel-provided eval with context |

**Open question:** Which method? Temp file is simplest but has I/O overhead. Blob import may work in Bun. Syscall is cleanest API but requires kernel support.

### Likely API

```typescript
// For AI and dynamic execution
const result = await exec(`
  const files = await readdir('/tmp');
  return files.length;
`);
// result = 5
```

## Error Handling

During development, show everything:
- TypeScript compilation errors
- Runtime exceptions
- Full stack traces

This can be dialed down later for production use.

## Process Library

The `@monk/process` library provides syscall wrappers:

```typescript
// @monk/process

// File operations
export function open(path: string, flags: number): Promise<number>;
export function close(fd: number): Promise<void>;
export function read(fd: number, size?: number): Promise<Uint8Array>;
export function write(fd: number, data: Uint8Array): Promise<number>;
export function stat(path: string): Promise<Stat>;
export function readdir(path: string): Promise<string[]>;
export function mkdir(path: string): Promise<void>;
export function unlink(path: string): Promise<void>;

// Convenience (path-based, opens/closes automatically)
export function read(path: string): Promise<Uint8Array>;
export function write(path: string, data: Uint8Array): Promise<void>;

// Process management
export function spawn(cmd: string, opts?: SpawnOpts): Promise<number>;
export function kill(pid: number, signal?: number): Promise<void>;
export function wait(pid: number): Promise<ExitStatus>;
export function exit(code: number): never;

// Network
export function connect(proto: string, host: string, port: number): Promise<number>;

// Ports
export function port(type: string, opts: object): Promise<number>;
export function send(portId: number, to: string, data: Uint8Array): Promise<void>;
export function recv(portId: number): Promise<Message>;

// Environment
export function getcwd(): string;
export function chdir(path: string): void;
export function getenv(name: string): string | undefined;
export function setenv(name: string, value: string): void;
```

## Examples

### Simple Script

```typescript
// /bin/hello.sh
console.log('Hello, Monk OS!');
```

### File Processing

```typescript
// /bin/wordcount.sh
const [, , path] = process.argv;
const content = await read(path);
const text = new TextDecoder().decode(content);
const words = text.split(/\s+/).filter(Boolean);
console.log(`${words.length} words`);
```

### Daemon

```typescript
// /bin/httpd.sh
import { port } from '@monk/process';

const listener = await port('tcp:listen', { port: 8080 });
console.log('Listening on :8080');

for await (const msg of listener) {
  const conn = msg.data;
  await conn.write(new TextEncoder().encode('HTTP/1.0 200 OK\r\n\r\nHello\n'));
  await conn.close();
}
```

### Using Libraries

```typescript
// /lib/format.ts
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// /bin/diskusage.sh
import { bytes } from '/lib/format.ts';

const files = await readdir('/data');
for (const f of files) {
  const info = await stat(`/data/${f}`);
  console.log(`${f}: ${bytes(info.size)}`);
}
```
