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

import { readdir, stat, unlink } from '@src/process';

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
import { port, connect, spawn } from '@src/process';

const listener = await port('tcp:listen', { port: 8080 });
```

**TBD:** Exact split between global and imported syscalls. Likely globals:
- `read`, `write`, `open`, `close`
- `stat`, `readdir`, `mkdir`, `unlink`
- `getcwd`, `chdir`

Likely imports:
- `spawn`, `kill`, `wait`, `exit`
- `port`, `send`, `recv`, `connect`
- `pipe` (for inter-process communication)
- `access`, `chmod`

## Interactive Shell

The shell (`src/bin/shell.ts`) is a traditional command interpreter:

```
$ ls /home
user  guest

$ echo hello world
hello world

$ cat /etc/config | grep key
key=value

$ cd /tmp && pwd
/tmp
```

See "Shell Implementation Status" section below for full feature list.

## VFS-Backed Execution

Scripts stored in VFS can be executed directly. No bundling at compile time - the kernel
loads, compiles, and runs scripts on demand.

### Architecture Overview

```
VFS Source                    Module Cache (LRU)              Worker Bundle
─────────────                 ─────────────────               ─────────────
/lib/process.ts    ──────►   cache['/lib/process'] = {js}
/lib/utils.ts      ──────►   cache['/lib/utils'] = {js}
/bin/myscript.ts   ──────►   cache['/bin/myscript'] = {js}
                                       │
                                       ▼
                             Assemble at spawn time
                                       │
                                       ▼
                             ┌─────────────────────────┐
                             │ Module Registry (loader)│
                             │ /lib/process.js         │
                             │ /lib/utils.js           │
                             │ /bin/myscript.js (entry)│
                             └─────────────────────────┘
                                       │
                                       ▼
                                   Blob URL
                                       │
                                       ▼
                                    Worker
```

### Key Design Decisions

1. **Dynamic linking, not static bundling** - modules compiled separately, assembled at spawn
2. **In-memory LRU cache** - compiled modules cached in kernel memory
3. **No temp files** - transpile in memory, load via Blob URL
4. **VFS paths for imports** - scripts use `/lib/process`, not `@src/process`

### Module Cache

Compiled modules are cached in kernel memory with LRU eviction:

```typescript
interface CachedModule {
    /** Transpiled JavaScript with rewritten imports */
    js: string;

    /** VFS paths this module imports */
    imports: string[];

    /** Source content hash for invalidation */
    hash: string;

    /** Last access time for LRU eviction */
    usedAt: number;
}

class ModuleCache {
    private cache = new Map<string, CachedModule>();
    private maxSize = 100;  // max modules to cache

    get(path: string): CachedModule | undefined;
    set(path: string, mod: CachedModule): void;
    evictLRU(): void;
    invalidate(path: string): void;
    clear(): void;
}
```

**Cache invalidation:**
- On `spawn()`: check source hash, recompile if changed
- On file `write()`: could proactively invalidate (optional optimization)
- On kernel restart: cache is empty, rebuild on demand

### Compilation Pipeline

#### Step 1: Compile Module

```typescript
async function compileModule(vfsPath: string): Promise<CachedModule> {
    const source = await vfs.readFile(vfsPath);
    const hash = Bun.hash(source).toString(16);

    // Check cache
    const cached = moduleCache.get(vfsPath);
    if (cached && cached.hash === hash) {
        cached.usedAt = Date.now();
        return cached;
    }

    // Transpile TypeScript → JavaScript
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const js = transpiler.transformSync(source);

    // Extract VFS imports
    const imports = extractImports(js).filter(p => p.startsWith('/'));

    // Rewrite imports to use module registry
    const rewritten = rewriteImports(js);

    const mod: CachedModule = {
        js: rewritten,
        imports,
        hash,
        usedAt: Date.now()
    };

    moduleCache.set(vfsPath, mod);
    return mod;
}
```

#### Step 2: Rewrite Imports

ES imports are transformed to registry lookups:

```typescript
// Before (VFS source)
import { open, read } from '/lib/process';
import { helper } from '/lib/utils';
export function myFunc() { ... }

// After (compiled module)
const { open, read } = __require('/lib/process');
const { helper } = __require('/lib/utils');
function myFunc() { ... }
exports.myFunc = myFunc;
```

```typescript
function rewriteImports(js: string): string {
    let result = js;

    // import { x, y } from '/path'  →  const { x, y } = __require('/path')
    result = result.replace(
        /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
        (_, imports, path) => {
            if (path.startsWith('/')) {
                return `const {${imports}} = __require('${path}')`;
            }
            return `const {${imports}} = __require('${path}')`;  // external
        }
    );

    // import x from '/path'  →  const x = __require('/path').default
    result = result.replace(
        /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        (_, name, path) => `const ${name} = __require('${path}').default`
    );

    // import * as x from '/path'  →  const x = __require('/path')
    result = result.replace(
        /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        (_, name, path) => `const ${name} = __require('${path}')`
    );

    // export { x }  →  exports.x = x
    result = result.replace(
        /export\s+\{([^}]+)\}/g,
        (_, names) => {
            const items = names.split(',').map((n: string) => n.trim());
            return items.map((n: string) => `exports.${n} = ${n}`).join('; ');
        }
    );

    // export function x()  →  function x() ... exports.x = x
    result = result.replace(
        /export\s+(function|class|const|let|var)\s+(\w+)/g,
        '$1 $2'
    );
    // (exports added separately after parsing)

    return result;
}
```

#### Step 3: Resolve Dependencies

Walk the dependency graph, compiling each module:

```typescript
async function resolveDependencies(entryPath: string): Promise<Map<string, CachedModule>> {
    const modules = new Map<string, CachedModule>();
    const queue = [entryPath];

    while (queue.length > 0) {
        const path = queue.shift()!;
        if (modules.has(path)) continue;

        const mod = await compileModule(path);
        modules.set(path, mod);

        // Queue unresolved dependencies
        for (const imp of mod.imports) {
            if (!modules.has(imp)) {
                queue.push(imp);
            }
        }
    }

    return modules;
}
```

#### Step 4: Assemble Bundle

Combine modules with a minimal CommonJS-style registry:

```typescript
async function assembleBundle(entryPath: string): Promise<string> {
    const modules = await resolveDependencies(entryPath);

    // Module registry preamble
    let bundle = `
'use strict';
const __modules = {};
const __cache = {};

function __require(path) {
    if (__cache[path]) return __cache[path];
    if (!__modules[path]) throw new Error('Module not found: ' + path);
    const module = { exports: {} };
    const exports = module.exports;
    __modules[path](module, exports, __require);
    __cache[path] = module.exports;
    return module.exports;
}

`;

    // Add each module as a factory function
    for (const [path, mod] of modules) {
        bundle += `
// ${path}
__modules['${path}'] = function(module, exports, __require) {
${mod.js}
};

`;
    }

    // Execute entry point
    bundle += `
// Entry point
__require('${entryPath}');
`;

    return bundle;
}
```

#### Step 5: Spawn Worker

```typescript
async function spawnFromVFS(entryPath: string, opts: SpawnOpts): Promise<Process> {
    // Assemble bundle from cached modules
    const bundle = await assembleBundle(entryPath);

    // Create Blob URL (no temp files)
    const blob = new Blob([bundle], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    // Create worker
    const worker = new Worker(url);

    // Cleanup URL (worker already loaded the code)
    URL.revokeObjectURL(url);

    // Standard process setup
    const proc = createProcess(worker, entryPath, opts);
    wireUpSyscalls(proc);

    return proc;
}
```

### Import Resolution

Scripts use VFS paths for imports:

```typescript
// /bin/myapp.ts
import { open, read, write, exit } from '/lib/process';
import { formatBytes } from '/lib/utils';
import { Config } from '/lib/config';
```

**Path resolution rules:**

| Import Path | Resolved To |
|-------------|-------------|
| `/lib/process` | VFS path `/lib/process.ts` |
| `/lib/utils.ts` | VFS path `/lib/utils.ts` (explicit extension) |
| `./helper` | Relative to importing module |
| `bun:test` | Bun built-in (passed through) |
| `node:fs` | Node built-in (passed through) |

```typescript
function resolveImport(importPath: string, fromModule: string): string {
    // Absolute VFS path
    if (importPath.startsWith('/')) {
        return importPath.endsWith('.ts') ? importPath : importPath + '.ts';
    }

    // Relative path
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
        const dir = dirname(fromModule);
        const resolved = resolve(dir, importPath);
        return resolved.endsWith('.ts') ? resolved : resolved + '.ts';
    }

    // Built-in or external - pass through unchanged
    return importPath;
}
```

### Process Library Bootstrap

The process library (`/lib/process.ts`) is special - it's the bridge between
userland and kernel. Options for providing it:

**Option A: Pre-populated in VFS**

On kernel boot, write the process library to VFS:

```typescript
// During kernel init
await vfs.writeFile('/lib/process.ts', PROCESS_LIB_SOURCE);
```

The source is bundled with the kernel binary. Scripts import it like any other module.

**Option B: Virtual module**

The kernel intercepts imports of `/lib/process` and provides it directly:

```typescript
if (importPath === '/lib/process') {
    return { js: BUILTIN_PROCESS_LIB, imports: [], hash: 'builtin' };
}
```

No VFS entry needed. The module exists only in the registry.

**Recommendation:** Option A - simpler, consistent, allows inspection/modification.

### Example: Full Execution Flow

```typescript
// User runs: spawn('/bin/hello.ts')

// 1. Kernel receives spawn syscall
//    entryPath = '/bin/hello.ts'

// 2. Read /bin/hello.ts from VFS
const source = `
import { println, exit } from '/lib/process';
await println('Hello, Monk OS!');
exit(0);
`;

// 3. Compile /bin/hello.ts
//    - Transpile TS → JS
//    - Rewrite imports
//    - Extract dependencies: ['/lib/process']

// 4. Compile /lib/process.ts (if not cached)
//    - Already cached from previous spawn

// 5. Assemble bundle
const bundle = `
'use strict';
const __modules = {};
const __cache = {};
function __require(path) { ... }

__modules['/lib/process'] = function(module, exports, __require) {
    // syscall bridge, println, exit, etc.
};

__modules['/bin/hello.ts'] = function(module, exports, __require) {
    const { println, exit } = __require('/lib/process');
    await println('Hello, Monk OS!');
    exit(0);
};

__require('/bin/hello.ts');
`;

// 6. Create Blob URL
const url = URL.createObjectURL(new Blob([bundle]));

// 7. Spawn Worker
const worker = new Worker(url);

// 8. Wire up syscall handling, fds, etc.
```

### Performance Considerations

| Operation | Cost | Mitigation |
|-----------|------|------------|
| VFS read | I/O | Cache compiled modules |
| Transpile | CPU | Cache compiled modules |
| Dependency walk | I/O | Cache module imports |
| Bundle assembly | CPU (string concat) | Small, fast |
| Blob URL creation | Memory | Revoke after load |

**Typical spawn time:**
- Cold (nothing cached): ~10-50ms depending on module count
- Warm (all cached): ~1-5ms (assembly + worker creation)

### Cache Sizing

```typescript
const CACHE_CONFIG = {
    maxModules: 100,        // max cached modules
    maxSizeBytes: 10_000_000,  // 10MB total JS
    ttlMs: 30 * 60 * 1000,  // 30 min unused = eligible for eviction
};
```

### Future: Persistent Cache (Option B)

If cache misses become expensive, graduate to StorageEngine-backed cache:

```
bundle:{path}:{hash}  →  compiled JS
```

Survives kernel restart. See OS_VERSIONING.md for keyspace patterns.

## Dynamic Execution

For AI and tools that generate code at runtime:

```typescript
// Write to VFS, spawn
await vfs.writeFile('/tmp/dynamic-123.ts', generatedCode);
const pid = await spawn('/tmp/dynamic-123.ts');
const result = await wait(pid);
await vfs.unlink('/tmp/dynamic-123.ts');
```

Or a convenience syscall:

```typescript
// exec() - write, spawn, wait, cleanup in one call
const result = await exec(`
    const files = await readdir('/tmp');
    return files.length;
`);
// result = 5
```

Implementation of `exec()`:

```typescript
async function exec(code: string, opts?: ExecOpts): Promise<unknown> {
    const path = `/tmp/.exec-${crypto.randomUUID()}.ts`;

    // Wrap code to capture return value
    const wrapped = `
        import { exit, write } from '/lib/process';
        const __result = await (async () => {
            ${code}
        })();
        await write(1, JSON.stringify(__result));
        exit(0);
    `;

    await vfs.writeFile(path, wrapped);

    const [readFd, writeFd] = await pipe();
    const pid = await spawn(path, { stdout: writeFd });
    await close(writeFd);

    const output = await readAll(readFd);
    await close(readFd);
    await wait(pid);
    await vfs.unlink(path);

    return JSON.parse(output);
}
```

## Error Handling

During development, show everything:
- TypeScript compilation errors
- Runtime exceptions
- Full stack traces

This can be dialed down later for production use.

## Process Library

The `@src/process` library provides syscall wrappers:

```typescript
// @src/process

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

// Pipes
export function pipe(): Promise<[number, number]>;  // [readFd, writeFd]

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
import { port } from '@src/process';

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

## Shell Implementation Status

The shell (`src/bin/shell.ts`) provides a command interpreter for Monk OS.

| Feature | Status | Notes |
|---------|--------|-------|
| Command parsing | ✅ Done | Via `src/lib/shell/` |
| Variable expansion | ✅ Done | `$VAR`, `${VAR}`, `${VAR:-default}`, `~` |
| Glob expansion | ✅ Done | `*`, `?`, `[...]` |
| Command history | ✅ Done | In-memory |
| Pipes (`\|`) | ✅ Done | Uses kernel `pipe()` syscall |
| Chaining (`&&`, `\|\|`) | ✅ Done | Short-circuit evaluation |
| Redirects (`<`, `>`, `>>`) | ✅ Done | Uses `redirect()` syscall for builtins |
| Background (`&`) | ⏳ Pending | Requires job control |

### Built-in Commands

| Command | Description |
|---------|-------------|
| `cd` | Change directory |
| `pwd` | Print working directory |
| `export` | Set environment variable |
| `history` | Show command history |
| `exit` | Exit shell |
| `echo` | Output text |
| `true` | Return success (0) |
| `false` | Return failure (1) |

### Usage

```bash
shell              # Interactive mode
shell -c "cmd"     # Execute single command
shell script.sh    # Execute script file
shell --version    # Show version
shell --help       # Show help
```

### Pipeline Example

```bash
$ cat /etc/passwd | grep root | head -1
```

The shell creates pipes between commands and runs them concurrently. Each command's stdout is connected to the next command's stdin via kernel pipes.
