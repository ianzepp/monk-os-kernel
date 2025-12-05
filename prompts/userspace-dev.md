# Userspace Developer Code Review Prompt

Use this prompt when rewriting userspace files in Monk OS (`rom/bin/*` commands and `rom/lib/*` libraries).

---

## The Prompt

```
I'd like you to pretend a GNU coreutils maintainer and a staff engineer TypeScript developer had a baby, and that baby was doing a code review on [FILENAME]. I'm looking for:

1. **POSIX compatibility** - Ensure behavior matches standard GNU/POSIX specifications where applicable
2. **Stream handling** - Properly handle stdin, stdout, stderr, and pipeline composition
3. **Error handling** - Use correct exit codes, write errors to stderr, handle edge cases gracefully
4. **Argument parsing** - Robust flag handling with clear help text and validation
5. **Type safety** - Leverage TypeScript's type system to prevent runtime errors

Produce a rewritten [FILENAME] that both parents would be proud of.
```

---

## Expected Output Structure

The rewritten file should follow this structure:

### 1. Command Header Block (for `rom/bin/*`)

```typescript
/**
 * [command] - [One-line description matching man page style]
 *
 * SYNOPSIS
 * ========
 * [command] [OPTIONS] [ARGUMENTS]
 *
 * DESCRIPTION
 * ===========
 * [2-4 paragraphs explaining what the command does]
 *
 * POSIX/GNU COMPATIBILITY
 * =======================
 * Base: [POSIX.1-2017 | GNU coreutils X.Y | custom]
 * Supported flags: -a, -b, -c, ...
 * Unsupported flags: -x, -y, -z (reason)
 * Extensions: --monk-specific (description)
 *
 * EXIT CODES
 * ==========
 * 0 - Success
 * 1 - General error (describe when)
 * 2 - Usage error (invalid arguments)
 * [other codes as needed]
 *
 * MESSAGE BEHAVIOR
 * ================
 * stdin:  [consumed | ignored | optional] - expects [item | data | any] messages
 * stdout: [message types sent: item({ text }), data(bytes), etc.]
 * stderr: [error message format via respond.item({ text })]
 *
 * EDGE CASES
 * ==========
 * - Empty input: [behavior]
 * - Missing files: [behavior]
 * - Binary data: [behavior]
 * - [other edge cases]
 *
 * @module rom/bin/[command]
 */
```

### 2. Library Header Block (for `rom/lib/*`)

```typescript
/**
 * [Library Name] - [One-line description]
 *
 * PURPOSE
 * =======
 * [2-4 paragraphs explaining the library's role]
 *
 * API DESIGN
 * ==========
 * [Explain the public interface philosophy]
 *
 * ERROR HANDLING
 * ==============
 * [Explain how errors are reported - exceptions, error codes, Result types]
 *
 * USAGE EXAMPLES
 * ==============
 * ```typescript
 * // Example 1: Basic usage
 * const result = await someFunction();
 *
 * // Example 2: Error handling
 * try {
 *     await riskyOperation();
 * } catch (err) {
 *     // Handle specific error
 * }
 * ```
 *
 * @module rom/lib/[name]
 */
```

### 3. Imports Section

```typescript
// =============================================================================
// IMPORTS
// =============================================================================

// Monk OS syscalls and types
import { read, write, exit, stat } from '@src/process';
import type { Stat, OpenFlags } from '@src/types';

// Local utilities
import { parseArgs, formatError } from '@rom/lib/utils';
```

---

## Standard Library Usage (Required)

> **IMPORTANT**: Always use the userspace standard library (`rom/lib/*`) instead of
> implementing common functionality inline. This ensures consistency across commands
> and reduces code duplication.

### Available Libraries

| Library | Purpose | Key Exports |
|---------|---------|-------------|
| `@rom/lib/args` | Argument parsing | `parseArgs()`, `parseDuration()` |
| `@rom/lib/process` | Syscalls, I/O | `recv`, `send`, `open`, `read`, `write`, `exit`, `println`, `eprintln` |
| `@rom/lib/shell` | Shell utilities | `resolvePath()` |
| `@rom/lib/path` | Path manipulation | `basename()`, `dirname()`, `join()` |
| `@rom/lib/utils` | Common utilities | `formatError()`, `sortBy()` |
| `@rom/lib/format` | Output formatting | Table formatting, alignment |
| `@rom/lib/glob` | Pattern matching | `glob()`, `match()` |
| `@rom/lib/io` | High-level I/O | `ByteReader`, `ByteWriter` |

### Argument Parsing

**Always use `parseArgs()` from `@rom/lib/args`** for command-line parsing:

```typescript
import { parseArgs } from '@rom/lib/args';

const result = parseArgs(args.slice(1), {
    help:    { short: 'h', long: 'help' },
    verbose: { short: 'v', long: 'verbose' },
    count:   { short: 'n', long: 'count', value: true },
});

if (result.flags.help) {
    await println(HELP_TEXT);
    return exit(EXIT_SUCCESS);
}

if (result.errors.length > 0) {
    await eprintln(`command: ${result.errors[0]}`);
    return exit(EXIT_USAGE);
}

// Use result.flags.verbose, result.flags.count, result.positional
```

**Do NOT** implement custom argument parsing loops unless `parseArgs()` cannot handle your use case.

---

### 4. Constants Section

```typescript
// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Exit code for successful execution.
 * POSIX: Standard success code.
 */
const EXIT_SUCCESS = 0;

/**
 * Exit code for general errors.
 * POSIX: Catchall for general errors.
 */
const EXIT_FAILURE = 1;

/**
 * Exit code for usage/syntax errors.
 * GNU: Standard for invalid arguments.
 */
const EXIT_USAGE = 2;

/**
 * Default buffer size for stream operations.
 * WHY: 64KB balances memory usage with syscall overhead.
 */
const BUFFER_SIZE = 64 * 1024;
```

### 5. Types Section

```typescript
// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed command-line options.
 *
 * DESIGN: Each flag maps to a clear, typed field.
 * Boolean flags use true/false, not presence/absence.
 */
interface Options {
    /** Show help and exit */
    help: boolean;
    /** Enable verbose output */
    verbose: boolean;
    /** Input files (positional arguments) */
    files: string[];
}

/**
 * Default options when no flags provided.
 */
const DEFAULT_OPTIONS: Options = {
    help: false,
    verbose: false,
    files: [],
};
```

### 6. Help Text

```typescript
// =============================================================================
// HELP TEXT
// =============================================================================

/**
 * Usage text displayed with --help or on usage error.
 *
 * FORMAT: Follows GNU conventions:
 * - First line: Usage: command [OPTIONS] ARGS
 * - Blank line
 * - Description paragraph
 * - Blank line
 * - Options list (aligned)
 */
const HELP_TEXT = `
Usage: command [OPTIONS] [FILE]...

One-line description of what the command does.

Options:
  -h, --help     Display this help and exit
  -v, --verbose  Explain what is being done

Examples:
  command file.txt          Process a single file
  command -v *.txt          Process with verbose output
  cat data | command -      Read from stdin
`.trim();
```

### 7. Main Function Structure

```typescript
// =============================================================================
// MAIN
// =============================================================================

/**
 * Entry point for the command.
 *
 * ALGORITHM:
 * 1. Parse command-line arguments
 * 2. Validate options and arguments
 * 3. Process each input (files or stdin)
 * 4. Exit with appropriate code
 *
 * ERROR HANDLING:
 * - Usage errors: Print to stderr, exit 2
 * - Runtime errors: Print to stderr, exit 1
 * - Success: Exit 0
 */
export default async function main(args: string[]): Promise<void> {
    // -------------------------------------------------------------------------
    // Argument Parsing
    // -------------------------------------------------------------------------
    const opts = parseOptions(args);

    if (opts.help) {
        await write(1, HELP_TEXT + '\n');
        return exit(EXIT_SUCCESS);
    }

    // -------------------------------------------------------------------------
    // Input Validation
    // -------------------------------------------------------------------------
    if (opts.files.length === 0) {
        // No files specified - read from stdin
        opts.files.push('-');
    }

    // -------------------------------------------------------------------------
    // Processing
    // -------------------------------------------------------------------------
    let hadError = false;

    for (const file of opts.files) {
        try {
            await processFile(file, opts);
        } catch (err) {
            await write(2, `command: ${file}: ${formatError(err)}\n`);
            hadError = true;
            // Continue processing remaining files (GNU behavior)
        }
    }

    return exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}
```

---

## Comment Style Guide

### Function Comments

```typescript
/**
 * [Brief description in imperative mood: "Parse", "Write", "Convert"]
 *
 * GNU COMPATIBILITY: [Note any deviations from standard behavior]
 *
 * @param input - [Description, note if can be "-" for stdin]
 * @returns [Description]
 * @throws SyscallError - [When this error occurs]
 */
```

### Inline Comments

```typescript
// BAD: Check if file exists
if (await exists(path)) { ... }

// GOOD: POSIX: "-" means read from stdin, not a file named "-"
if (path === '-') { ... }

// GOOD: GNU: Continue on error, don't abort entire operation
hadError = true;
continue;
```

### Edge Case Comments

```typescript
// EDGE: Empty input produces no output (matches GNU behavior)
if (lines.length === 0) {
    return;
}

// EDGE: Binary files may contain null bytes - handle as raw bytes
const content = await read(fd, BUFFER_SIZE);
```

---

## POSIX/GNU Patterns to Follow

### 1. Standard Exit Codes

```typescript
// Standard exit codes (GNU conventions)
const EXIT_SUCCESS = 0;   // Successful execution
const EXIT_FAILURE = 1;   // General errors
const EXIT_USAGE = 2;     // Invalid usage/arguments

// Some commands have specific codes
const EXIT_MISMATCH = 1;  // diff: files differ
const EXIT_TROUBLE = 2;   // diff: trouble (e.g., missing file)
```

### 2. Error Message Format

```typescript
// GNU standard error format: "program: message"
await write(2, `cat: ${filename}: No such file or directory\n`);

// With context: "program: context: message"
await write(2, `cp: cannot stat '${src}': No such file or directory\n`);

// NEVER write errors to stdout
// NEVER include "Error:" prefix (redundant - it's on stderr)
```

### 3. Stdin Handling with "-"

```typescript
/**
 * Process input from file or stdin.
 *
 * POSIX: "-" as filename means read from stdin.
 * This is a universal convention across Unix tools.
 */
async function processInput(path: string): Promise<string> {
    if (path === '-') {
        // Read from stdin (fd 0)
        return readAll(0);
    }

    const fd = await open(path, 'r');
    try {
        return readAll(fd);
    } finally {
        await close(fd);
    }
}
```

### 4. Multiple File Processing

```typescript
/**
 * Process multiple files, continuing on error.
 *
 * GNU BEHAVIOR: Most commands process all files even if some fail.
 * The exit code reflects whether ANY file failed.
 */
async function processFiles(files: string[]): Promise<number> {
    let exitCode = EXIT_SUCCESS;

    for (const file of files) {
        try {
            await processFile(file);
        } catch (err) {
            await write(2, `command: ${file}: ${formatError(err)}\n`);
            exitCode = EXIT_FAILURE;
            // Continue processing remaining files
        }
    }

    return exitCode;
}
```

### 5. Flag Parsing Conventions

```typescript
/**
 * Parse command-line arguments.
 *
 * GNU CONVENTIONS:
 * - Single dash + letter: -v, -f
 * - Double dash + word: --verbose, --file
 * - Combined short flags: -vf equals -v -f
 * - "--" ends flag parsing (remaining args are positional)
 * - "-" as argument means stdin (not a flag)
 */
function parseOptions(args: string[]): Options {
    const opts = { ...DEFAULT_OPTIONS };
    let i = 0;

    while (i < args.length) {
        const arg = args[i];

        // "--" ends option parsing
        if (arg === '--') {
            opts.files.push(...args.slice(i + 1));
            break;
        }

        // "-" is stdin, not a flag
        if (arg === '-') {
            opts.files.push('-');
            i++;
            continue;
        }

        // Long options
        if (arg.startsWith('--')) {
            // ... handle long options
        }

        // Short options
        if (arg.startsWith('-')) {
            // ... handle short options
        }

        // Positional argument
        opts.files.push(arg);
        i++;
    }

    return opts;
}
```

---

## Message-Based I/O (Monk OS Specific)

> **CRITICAL**: Monk OS is **message-first, not byte-first**. Unlike traditional Unix where
> stdin/stdout/stderr are byte streams, Monk OS uses structured `Response` messages between
> processes. This is fundamental to how all userspace code works.

### The Response Type

```typescript
/**
 * All inter-process communication uses Response messages.
 * This is NOT a byte stream - it's a typed message protocol.
 */
interface Response {
    op: 'ok' | 'error' | 'item' | 'data' | 'event' | 'progress' | 'done' | 'redirect';
    data?: unknown;    // Structured data (objects, arrays, etc.)
    bytes?: Uint8Array; // Raw bytes when needed
}

// Helper to create responses
const respond = {
    ok: (data?) => ({ op: 'ok', data }),
    error: (code, message) => ({ op: 'error', data: { code, message } }),
    item: (data) => ({ op: 'item', data }),
    data: (bytes) => ({ op: 'data', bytes }),
    done: () => ({ op: 'done' }),
};
```

### Reading from stdin (fd 0)

```typescript
import { recv } from '@rom/lib/process';

/**
 * Process messages from stdin.
 *
 * MESSAGE PROTOCOL: recv() yields Response objects until 'done'.
 * This is NOT byte-by-byte reading.
 */
async function processInput(): Promise<void> {
    for await (const response of recv(0)) {
        // Each response is a typed message
        if (response.op === 'item') {
            const item = response.data as { text?: string };
            await processItem(item);
        } else if (response.op === 'data') {
            // Raw bytes available in response.bytes
            await processBytes(response.bytes!);
        }
    }
    // Loop ends when 'done' message received
}
```

### Writing to stdout/stderr (fd 1/2)

```typescript
import { send, respond } from '@rom/lib/process';

/**
 * Send output to stdout.
 *
 * MESSAGE PROTOCOL: send() transmits a Response message.
 * Use respond.item() for structured data with text.
 */
async function output(text: string): Promise<void> {
    // Send a structured message, not raw bytes
    await send(1, respond.item({ text }));
}

// Convenience functions in rom/lib/process/io.ts:
await print('hello');      // send(1, respond.item({ text: 'hello' }))
await println('hello');    // send(1, respond.item({ text: 'hello\n' }))
await eprint('error');     // send(2, respond.item({ text: 'error' }))
await eprintln('error');   // send(2, respond.item({ text: 'error\n' }))
```

### Message vs Byte I/O

```typescript
// =============================================================================
// MESSAGE I/O (for process communication - fd 0, 1, 2)
// =============================================================================
import { recv, send, respond } from '@rom/lib/process';

// Receive messages from stdin
for await (const msg of recv(0)) { ... }

// Send messages to stdout/stderr
await send(1, respond.item({ text: 'output' }));
await send(2, respond.item({ text: 'error' }));

// =============================================================================
// BYTE I/O (for file operations - regular file descriptors)
// =============================================================================
import { open, read, write, close } from '@rom/lib/process';

// Read bytes from file
const fd = await open('/path/to/file', { read: true });
for await (const chunk of read(fd)) {
    // chunk is Uint8Array
}

// Write bytes to file
await write(fd, new TextEncoder().encode('content'));
```

### Pipeline Composition with Messages

```typescript
/**
 * Pipeline-friendly command design.
 *
 * MONK PHILOSOPHY:
 * - Commands receive Response messages from previous command
 * - Commands send Response messages to next command
 * - 'done' message signals end of stream
 * - Messages can carry structured data, not just text
 */

// Example: A filter command
export default async function main(args: string[]): Promise<void> {
    // Read messages from stdin (piped from previous command)
    for await (const response of recv(0)) {
        if (response.op === 'item') {
            const item = response.data as { text?: string };
            if (item.text && shouldInclude(item.text)) {
                // Forward matching items to next command
                await send(1, response);
            }
        }
    }

    // Signal completion
    await send(1, respond.done());
    return exit(0);
}
```

---

## Library Design Patterns

### 1. Error Handling in Libraries

```typescript
/**
 * Library functions should throw typed errors, not exit.
 *
 * WHY: Libraries are called by commands, which decide how to handle errors.
 * Only the top-level command should call exit().
 */

// BAD: Library function calls exit
export function parseConfig(path: string): Config {
    if (!exists(path)) {
        exit(1);  // Don't do this in a library!
    }
}

// GOOD: Library function throws
export function parseConfig(path: string): Config {
    if (!exists(path)) {
        throw new ConfigError(`Config file not found: ${path}`);
    }
}
```

### 2. Async Consistency

```typescript
/**
 * Be consistent about sync vs async.
 *
 * RULE: If any operation might be async, make the whole function async.
 * This prevents callback hell and makes error handling consistent.
 */

// BAD: Mixed sync/async
export function process(data: string): string {
    const result = transformSync(data);
    fetchMetadata(data).then(...);  // Fire and forget - dangerous!
    return result;
}

// GOOD: Fully async
export async function process(data: string): Promise<string> {
    const [result, metadata] = await Promise.all([
        transform(data),
        fetchMetadata(data),
    ]);
    return applyMetadata(result, metadata);
}
```

### 3. Input Validation

```typescript
/**
 * Validate inputs at library boundaries.
 *
 * WHY: Catch errors early with clear messages.
 * Internal functions can assume valid inputs.
 */
export function createUser(name: string, age: number): User {
    // Validate at public API boundary
    if (!name || name.length === 0) {
        throw new ValidationError('name cannot be empty');
    }
    if (age < 0 || age > 150) {
        throw new ValidationError(`age must be 0-150, got ${age}`);
    }

    // Internal logic can trust inputs
    return internalCreateUser(name, age);
}
```

---

## Type Safety Patterns

### 1. Strict Array Access

```typescript
// With noUncheckedIndexedAccess, array access returns T | undefined

// BAD: Assumes element exists
const first = args[0];
console.log(first.toUpperCase());  // Error: possibly undefined

// GOOD: Explicit check
const first = args[0];
if (first === undefined) {
    throw new UsageError('missing required argument');
}
console.log(first.toUpperCase());  // Safe

// GOOD: Destructuring with default
const [first = ''] = args;
```

### 2. Exhaustive Switches

```typescript
/**
 * Use exhaustive switches for union types.
 *
 * WHY: Compiler will error if new variants are added.
 */
type Command = 'start' | 'stop' | 'restart';

function handleCommand(cmd: Command): void {
    switch (cmd) {
        case 'start':
            return start();
        case 'stop':
            return stop();
        case 'restart':
            return restart();
        default:
            // This ensures exhaustiveness
            const _exhaustive: never = cmd;
            throw new Error(`Unknown command: ${_exhaustive}`);
    }
}
```

### 3. Type Guards

```typescript
/**
 * Use type guards for runtime type checking.
 */
function isValidOption(value: unknown): value is Options {
    return (
        typeof value === 'object' &&
        value !== null &&
        'help' in value &&
        typeof value.help === 'boolean'
    );
}

// Usage
const parsed = JSON.parse(input);
if (!isValidOption(parsed)) {
    throw new Error('Invalid options format');
}
// parsed is now typed as Options
```

---

## Testing Userspace Code

> **CRITICAL**: Tests for userspace code (`rom/bin/*`, `rom/lib/*`) must use the `OS` public API,
> not kernel internals. We are testing userspace code through userspace interfaces.

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

// Standard exit codes
const EXIT = {
    SUCCESS: 0,
    FAILURE: 1,
} as const;

describe('command-name', () => {
    let os: OS;

    // Fresh OS instance per test for isolation
    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    it('should do something', async () => {
        // Spawn shell with command, capture output via redirect
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', 'echo hello > /tmp/out'],
        });

        const result = await handle.wait();
        expect(result.exitCode).toBe(EXIT.SUCCESS);

        // Read captured output via OS filesystem API
        const stdout = await os.fs.readText('/tmp/out');
        expect(stdout).toBe('hello\n');
    });
});
```

### Key Principles

1. **Use `OS` API, not kernel internals**
   - `os.process.spawn()` - NOT `kernel.boot()` or `kernel.spawnExternal()`
   - `os.fs.readText()` - NOT `vfs.open()` directly
   - Let the shell handle piping - that's the userspace code we're testing

2. **Fresh OS per test** (`beforeEach`)
   - Complete isolation between tests
   - No state leakage (files, processes)
   - Tests can run in any order

3. **Output capture via shell redirects**
   - Use `command > /tmp/out` in the shell command
   - Read with `os.fs.readText('/tmp/out')`
   - This tests the real shell redirect path

4. **Test through the shell**
   - Spawn `/bin/shell.ts` with `-c 'command'`
   - Shell handles pipes, redirects, command chaining
   - Tests exercise the full userspace stack

### Helper Pattern (optional)

For test files with many similar tests, extract a helper:

```typescript
/**
 * Run a shell command and capture output.
 */
async function run(command: string): Promise<{ exitCode: number; stdout: string }> {
    const handle = await os.process.spawn('/bin/shell.ts', {
        args: ['shell', '-c', `${command} > /tmp/out`],
    });

    const result = await handle.wait();
    const stdout = await os.fs.readText('/tmp/out');

    return { exitCode: result.exitCode, stdout };
}

// Usage
it('should echo hello', async () => {
    const result = await run('echo hello');
    expect(result.stdout).toBe('hello\n');
});
```

### What NOT to Do

```typescript
// BAD: Using kernel directly (bypasses userspace)
const kernel = stack.kernel!;
await kernel.boot({ initPath: '/bin/shell.ts', ... });

// BAD: Reading VFS directly (kernel internal)
const vfs = stack.vfs!;
const handle = await vfs.open('/tmp/out', { read: true }, 'kernel');

// BAD: Mocking syscalls (defeats the purpose)
jest.mock('@rom/lib/process', () => ({ ... }));

// GOOD: Using OS public API
const os = new OS();
await os.boot();
const handle = await os.process.spawn('/bin/shell.ts', { ... });
const content = await os.fs.readText('/tmp/out');
```

### Test Location

- Command tests: `spec/rom/bin/<command>.test.ts`
- Library tests: `spec/rom/lib/<library>.test.ts`

---

## Checklist Before Submitting Rewrite

### Commands (`rom/bin/*`)
- [ ] Header with SYNOPSIS, DESCRIPTION, POSIX COMPATIBILITY, EXIT CODES
- [ ] HELP_TEXT follows GNU format with examples
- [ ] Exit codes match GNU conventions (0=success, 1=error, 2=usage)
- [ ] Errors written to stderr with "command: message" format
- [ ] "-" handled as stdin where appropriate
- [ ] Multiple files processed with continue-on-error behavior
- [ ] **Use `parseArgs()` from `@rom/lib/args`** for flag parsing (not custom loops)

### Libraries (`rom/lib/*`)
- [ ] Header with PURPOSE, API DESIGN, ERROR HANDLING, USAGE EXAMPLES
- [ ] Functions throw errors, never call exit()
- [ ] Consistent async/sync behavior
- [ ] Input validation at public API boundaries
- [ ] Types exported for consumers

### Type Safety (all files)
- [ ] Array access handles undefined (noUncheckedIndexedAccess)
- [ ] Type-only imports use `import type`
- [ ] No unused variables or parameters
- [ ] Exhaustive switch statements for unions

### Verification (required)
- [ ] Run typecheck on your specific file(s) and fix any errors:
  ```bash
  bun x tsc --noEmit rom/bin/yourfile.ts
  # or for libraries:
  bun x tsc --noEmit rom/lib/yourfile.ts
  ```
- [ ] Report typecheck results (pass/fail, errors fixed)
