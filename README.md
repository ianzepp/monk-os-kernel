# Monk OS - Explained Simply

## What Is This?

Monk OS is a **mini operating system** that runs inside your JavaScript/TypeScript programs. Think of it like a tiny computer inside your computer.

Just like your Mac or Windows has files, folders, and running programs, Monk OS has all of that too - but it's all simulated in code.

## Why Would Anyone Want This?

Imagine you're building a web application. Normally, you'd:
- Store data in a database
- Read and write files
- Run background tasks
- Handle network connections

With Monk OS, all of these things work the same way - through "files." Want to store user data? Write it to a file. Want to check what programs are running? Read from a special folder. Want to send a network message? Also a file operation.

**One simple interface for everything.**

## The Big Ideas (In Plain English)

### "Everything Is a File"

This is the core philosophy. In Monk OS:
- Regular documents? Files (obviously)
- Database records? Also files
- Running programs? You can read their info from files
- Network connections? Yep, files too

This sounds weird, but it makes things consistent. Once you learn how to work with files, you can work with *everything*.

### "Bun Is the Hardware"

Monk OS runs on top of [Bun](https://bun.sh/), a fast JavaScript runtime (like Node.js but faster).

The analogy: If your laptop has a CPU, memory, and disk drive as hardware, then for Monk OS, Bun provides all of that. Bun is the "physical machine" that Monk OS runs on.

### Processes (Programs Running)

When you run a program in Monk OS, it runs in its own isolated bubble (called a "Worker"). Programs can't mess with each other directly - they have to communicate through official channels.

## The Layers (Simplified)

```
You write code here
        ↓
   [Your App]
        ↓
   [Monk OS] ← handles files, programs, networking
        ↓
     [Bun] ← the actual computer doing the work
```

## Real Example

```typescript
import { OS } from '@monk-api/os';

// Create a new mini operating system
const os = new OS();

// Start it up
await os.boot();

// Now you can use it like a real OS:
// - Create files
// - Run programs
// - Store data
// All through one consistent interface

// When done, shut it down
await os.shutdown();
```

## Key Terms Glossary

| Term | Simple Explanation |
|------|-------------------|
| **VFS** | Virtual File System - the fake disk drive where files live |
| **HAL** | Hardware Abstraction Layer - the code that talks to the real computer |
| **Kernel** | The "brain" of the OS that manages everything |
| **Process** | A running program |
| **Handle** | A ticket that lets you access something (file, network connection, etc.) |
| **Syscall** | A request from a program to the OS ("please read this file") |

## What Can It Actually Do?

- **Store data**: In memory, SQLite database, or PostgreSQL
- **Run programs**: TypeScript/JavaScript code in isolated workers
- **Network**: TCP connections, HTTP requests, WebSockets
- **File operations**: Read, write, copy, move, delete - all the usual stuff
- **Background services**: Programs that run continuously (like a web server)

## Also, It's Really Fast

You might think "a fake operating system inside my code must be slow." Nope.

**How fast?** Here are some real numbers:

| What | Speed | In Human Terms |
|------|-------|----------------|
| Finding a file | ~2 microseconds | You could look up 500,000 files per second |
| Reading data | ~35,000 ops/sec | Fast enough for most web apps |
| Writing data | ~25,000 ops/sec | That's a lot of database inserts |
| API calls through the gateway | ~50,000 ops/sec | Your bottleneck won't be Monk OS |

**Memory?** About 333 MB to track a million files. That's less than a Chrome tab.

**Why so fast?**
- Built on Bun (which is already fast)
- Smart caching everywhere
- No unnecessary copying of data
- MessagePack protocol (binary, not JSON text)

The abstraction layer adds some overhead compared to raw database calls, but you're trading a tiny bit of speed for a much simpler mental model. For most applications, you'll never notice.

## Who Is This For?

- **API developers** who want a consistent way to handle data and services
- **People building complex applications** who want better organization
- **Developers** who like the Unix/Plan 9 philosophy of "everything is a file"

## What This Is NOT

- Not a replacement for your actual operating system (Mac, Windows, Linux)
- Not something end users would interact with directly
- Not a virtual machine in the traditional sense

It's a **programming tool** - a way to structure your backend code using operating system concepts.

## Want to Learn More?

- [README_FOR_TECHIES.md](README_FOR_TECHIES.md) - Technical overview
- [AGENTS.md](AGENTS.md) - Deep technical documentation (for developers building on Monk OS)
