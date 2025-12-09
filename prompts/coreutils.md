# Coreutils Command Patterns

Quick reference for writing userspace commands in `rom/bin/`. Copy-paste these patterns for consistent, correct implementations.

---

## Skeleton: Minimal Command

The simplest working command:

```typescript
import { getargs, println, exit } from '@rom/lib/process/index.js';

export default async function main(): Promise<void> {
    const args = await getargs();
    const input = args.slice(1);

    await println(input.join(' '));
    await exit(0);
}
```

---

## Pattern 1: Output Only (echo, pwd, whoami, uname)

Commands that produce output without reading input.

```typescript
import { getargs, println, eprintln, exit } from '@rom/lib/process/index.js';
import { parseArgs } from '@rom/lib/args';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

const HELP_TEXT = `
Usage: command [OPTIONS] [ARGS]

Description of what the command does.

Options:
  -h, --help    Display this help and exit
`.trim();

const ARG_SPECS = {
    help: { short: 'h', long: 'help' },
};

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), ARG_SPECS);

    if (parsed.flags.help) {
        await println(HELP_TEXT);
        return exit(EXIT_SUCCESS);
    }

    // Do the thing
    await println('output');
    await exit(EXIT_SUCCESS);
}
```

---

## Pattern 2: File Reader (cat, head, tail)

Commands that read files and output their contents.

```typescript
import {
    getargs, getcwd, open, read, close,
    println, eprintln, exit, send, respond,
} from '@rom/lib/process/index.js';
import { parseArgs, resolvePath } from '@rom/lib/shell';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

async function processFile(path: string): Promise<void> {
    const fd = await open(path, { read: true });

    try {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        for await (const chunk of read(fd)) {
            buffer += decoder.decode(chunk, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                await println(line);
            }
        }

        buffer += decoder.decode();
        if (buffer) await println(buffer);
    }
    finally {
        await close(fd);
    }
}

export default async function main(): Promise<void> {
    const args = await getargs();
    const files = args.slice(1);

    if (files.length === 0) {
        files.push('-');  // Default to stdin
    }

    const cwd = await getcwd();
    let hadError = false;

    for (const file of files) {
        try {
            const path = resolvePath(cwd, file);
            await processFile(path);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`command: ${file}: ${msg}`);
            hadError = true;
        }
    }

    await send(1, respond.done());
    await exit(hadError ? EXIT_FAILURE : EXIT_SUCCESS);
}
```

---

## Pattern 3: Filter (grep, sort, uniq, tr)

Commands that read stdin, transform, and output.

```typescript
import {
    getargs, recv, println, eprintln, exit, send, respond,
} from '@rom/lib/process/index.js';
import { parseArgs } from '@rom/lib/args';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

async function filter(transform: (line: string) => string | null): Promise<void> {
    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const text = (msg.data as { text?: string }).text ?? '';

            // Remove trailing newline for processing
            const line = text.endsWith('\n') ? text.slice(0, -1) : text;

            const result = transform(line);
            if (result !== null) {
                await println(result);
            }
        }
    }
}

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), {});

    await filter(line => {
        // Transform or return null to skip
        return line.toUpperCase();
    });

    await send(1, respond.done());
    await exit(EXIT_SUCCESS);
}
```

---

## Pattern 4: Accumulator (wc, sort)

Commands that collect all input before producing output.

```typescript
import {
    getargs, recv, println, exit, send, respond,
} from '@rom/lib/process/index.js';

async function collectLines(): Promise<string[]> {
    const lines: string[] = [];

    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const text = (msg.data as { text?: string }).text ?? '';
            const line = text.endsWith('\n') ? text.slice(0, -1) : text;
            lines.push(line);
        }
    }

    return lines;
}

export default async function main(): Promise<void> {
    const lines = await collectLines();

    // Process collected lines
    const sorted = lines.sort();

    for (const line of sorted) {
        await println(line);
    }

    await send(1, respond.done());
    await exit(0);
}
```

---

## Pattern 5: Directory Lister (ls, find)

Commands that list filesystem contents.

```typescript
import {
    getargs, getcwd, readdirAll, stat,
    println, eprintln, exit,
} from '@rom/lib/process/index.js';
import { parseArgs, resolvePath } from '@rom/lib/shell';

export default async function main(): Promise<void> {
    const args = await getargs();
    const parsed = parseArgs(args.slice(1), {
        long: { short: 'l', long: 'long' },
        all: { short: 'a', long: 'all' },
    });

    const cwd = await getcwd();
    const path = parsed.positional[0] ?? '.';
    const resolved = resolvePath(cwd, path);

    try {
        const entries = await readdirAll(resolved);

        for (const entry of entries) {
            // Skip hidden files unless -a
            if (!parsed.flags.all && entry.name.startsWith('.')) {
                continue;
            }

            if (parsed.flags.long) {
                const info = await stat(`${resolved}/${entry.name}`);
                await println(`${info.model}  ${info.size}  ${entry.name}`);
            }
            else {
                await println(entry.name);
            }
        }

        await exit(0);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`ls: ${path}: ${msg}`);
        await exit(1);
    }
}
```

---

## Pattern 6: File Writer (tee, cp)

Commands that write to files.

```typescript
import {
    getargs, getcwd, open, write, close,
    recv, send, println, eprintln, exit, respond,
} from '@rom/lib/process/index.js';
import { resolvePath } from '@rom/lib/shell';

export default async function main(): Promise<void> {
    const args = await getargs();
    const files = args.slice(1);

    const cwd = await getcwd();
    const fds: number[] = [];

    // Open all output files
    for (const file of files) {
        try {
            const path = resolvePath(cwd, file);
            const fd = await open(path, { write: true, create: true, truncate: true });
            fds.push(fd);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await eprintln(`tee: ${file}: ${msg}`);
        }
    }

    const encoder = new TextEncoder();

    // Read stdin, write to all outputs
    for await (const msg of recv(0)) {
        if (msg.op === 'item') {
            const text = (msg.data as { text?: string }).text ?? '';

            // Write to stdout
            await println(text.endsWith('\n') ? text.slice(0, -1) : text);

            // Write to all files
            const bytes = encoder.encode(text);
            for (const fd of fds) {
                await write(fd, bytes);
            }
        }
    }

    // Cleanup
    for (const fd of fds) {
        await close(fd);
    }

    await send(1, respond.done());
    await exit(0);
}
```

---

## Common Imports

```typescript
// Most commands need these
import {
    getargs,        // Get argv
    getcwd,         // Current directory
    println,        // Print line to stdout
    eprintln,       // Print line to stderr
    exit,           // Exit with code
    send,           // Send message to fd
    respond,        // Response helpers
} from '@rom/lib/process/index.js';

// File operations
import {
    open,           // Open file -> fd
    read,           // Read from fd (async iterator)
    write,          // Write bytes to fd
    close,          // Close fd
    stat,           // File info
    readFile,       // Read entire file as string
    writeFile,      // Write string to file
    mkdir,          // Create directory
    readdirAll,     // List directory contents
} from '@rom/lib/process/index.js';

// Stdin operations
import {
    recv,           // Receive messages from fd (async iterator)
} from '@rom/lib/process/index.js';

// Shell utilities
import { parseArgs, resolvePath } from '@rom/lib/shell';
```

---

## Exit Codes

```typescript
const EXIT_SUCCESS = 0;   // Everything worked
const EXIT_FAILURE = 1;   // Something failed
const EXIT_USAGE = 2;     // Bad arguments
```

---

## Error Message Format

```typescript
// GNU standard: "command: context: message"
await eprintln(`cat: ${filename}: No such file or directory`);
await eprintln(`grep: invalid option -- 'x'`);

// Multiple files: continue on error, report all, exit 1 at end
let hadError = false;
for (const file of files) {
    try {
        await processFile(file);
    }
    catch (err) {
        await eprintln(`command: ${file}: ${err.message}`);
        hadError = true;
    }
}
await exit(hadError ? 1 : 0);
```

---

## Pipeline Protocol

Commands should:

1. **Read messages** from stdin via `recv(0)`
2. **Write messages** to stdout via `println()` or `send(1, respond.item(...))`
3. **Signal done** with `send(1, respond.done())` before exit

```typescript
// Reading from stdin
for await (const msg of recv(0)) {
    if (msg.op === 'item') {
        const text = (msg.data as { text?: string }).text ?? '';
        // Process text...
    }
}

// Writing to stdout (two equivalent ways)
await println('output line');
await send(1, respond.item({ text: 'output line\n' }));

// Always signal done before exit
await send(1, respond.done());
await exit(0);
```

---

## Stdin Handling

```typescript
// Default to stdin if no files specified
const files = parsed.positional;
if (files.length === 0) {
    files.push('-');
}

// Process files, treating "-" as stdin
for (const file of files) {
    if (file === '-') {
        await processStdin();
    }
    else {
        await processFile(file);
    }
}
```

---

## Checklist

- [ ] Uses `export default async function main()`
- [ ] Calls `getargs()` for arguments
- [ ] Uses `parseArgs()` from `@rom/lib/args` or `@rom/lib/shell`
- [ ] Handles `--help` flag
- [ ] Writes errors to stderr with `eprintln()`
- [ ] Errors format: `command: context: message`
- [ ] Calls `send(1, respond.done())` before exit
- [ ] Uses correct exit codes (0, 1, 2)
- [ ] Handles `-` as stdin where appropriate
- [ ] Continues processing on error (GNU behavior)
