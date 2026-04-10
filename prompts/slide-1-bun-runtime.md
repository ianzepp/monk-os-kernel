# Slide 1: Bun Runtime — The Hardware

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Variant A: Motherboard Schematic

### Layout: Circuit Board with Labeled Chip Packages

### Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a hardware reference schematic taped above an engineer's workstation.

TOP: Bold hand-lettered "1. BUN RUNTIME — THE HARDWARE" in white with amber double underline. Cyan subtitle: "Bun is not hosting an app. Bun IS the physical machine."

MAIN AREA — MOTHERBOARD: The center is a top-down circuit board layout with white and cyan PCB traces on navy. Four chip clusters arranged in quadrants:

Upper left — COMPUTE: Large chip "WORKERS" with 4 parallel rectangles inside, annotation "isolated memory, postMessage IPC". Smaller adjacent chip "SharedArrayBuffer" with annotation "mutex, semaphore, condvar". Traces connect them.

Upper right — STORAGE: Three chips grouped by an amber bracket labeled "3 STORAGE BACKENDS". Chip "SQLite" with cylinder icon, "WAL mode, embedded". Chip "PostgreSQL" with cylinder and network lines, "MVCC, distributed". Small chip "MEMORY", "ephemeral, testing".

Lower left — NETWORK: Chip "TCP/UDP" with antenna icon, "Bun.listen, Bun.connect, raw sockets". Chip "fetch", "HTTP/HTTPS". Chip "WebSocket", "bidirectional persistent". Small chip "DNS", "hostname resolution". Traces extend to port icons at board edge.

Lower right — UTILITIES: Chip "WebCrypto" with lock icon. Chip "Bun.spawn" with terminal icon, "host OS escape — kernel only". Chip "console", "stdin/stdout/stderr". Chip "timers", "setTimeout, nanoseconds".

A bold horizontal amber dashed line labeled "HAL BOUNDARY" runs across the center. Below: "raw Bun primitives". Above (fading to top edge): "17 HAL device interfaces". Thin traces from each chip cross upward through this boundary.

LEFT MARGIN: Pinned amber card titled "FIRMWARE": "bun build --compile produces a single executable. this isn't packaging — it's burning firmware." Word "firmware" double-underlined.

RIGHT MARGIN: Pinned card titled "RULE": "kernel code NEVER touches Bun directly. need a timer? hal.timer. need entropy? hal.entropy. this makes the system testable — mock HAL, test kernel in isolation."

BOTTOM: Comparison in a horizontal box. Left stack: "App → Framework → Runtime → OS → Hardware". Right stack: "Userland → Kernel → HAL → Bun" with "Bun" on a bold "hardware boundary" line. Between them: "same abstraction."

Faint cyan margin scribbles: "Workers = true isolation, not green threads", "SQLite WAL = readers never block", "all HAL ops async/await".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.

---

## Variant B: Exploded Assembly Diagram

### Layout: Vertical Exploded View — Primitives Assembling into HAL

### Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of an exploded assembly diagram from a hardware manual showing discrete components stacking into a functioning unit.

TOP: Bold hand-lettered "1. BUN RUNTIME — THE HARDWARE" in white with amber double underline. Cyan subtitle: "discrete primitives below. unified device interfaces above."

MAIN AREA — VERTICAL EXPLODED VIEW occupying full height, three tiers:

BOTTOM TIER — RAW PRIMITIVES: Twelve component blocks float in a loose row, each an isometric box with a label and icon. "Worker" with parallel lines, "SQLite" with cylinder, "PostgreSQL" with cylinder and network lines, "Bun.listen" with antenna, "Bun.connect" with plug, "fetch" with arrow, "WebSocket" with bidirectional arrow, "Bun.spawn" with terminal, "SharedArrayBuffer" with grid, "crypto" with lock, "Date/nanoseconds" with clock, "console" with screen. Each has thin upward dashed assembly arrows.

MIDDLE — HAL BOUNDARY: A bold amber-gold dashed line spanning full width, labeled "HAL ABSTRACTION BOUNDARY" with dimension-line endpoints. Below: "Bun-specific, platform-coupled". Above: "abstract, mockable, platform-independent".

UPPER TIER — ASSEMBLED DEVICES: 17 uniform module outlines in a tight organized row, each with a standardized interface symbol. Labels: "BlockDevice, StorageEngine, NetworkDevice, TimerDevice, ClockDevice, EntropyDevice, CryptoDevice, ConsoleDevice, DNSDevice, HostDevice, IPCDevice, ChannelDevice, CompressionDevice, FileDevice, JsonDevice, YamlDevice, RedisDevice". Amber bracket: "17 HAL DEVICE INTERFACES". Thin traces converge upward to top edge: "→ EMS, VFS, Kernel".

LEFT CARDS: Upper — amber card "THE INSIGHT": "Bun provides Workers, networking, storage, crypto, timers. These are what hardware provides to an OS. Therefore: treat Bun as hardware." Last line double-underlined. Lower — card "STORAGE BACKENDS": three rows: "memory — ephemeral", "sqlite — WAL, single-node", "postgres — MVCC, multi-node". Below: "same interface, swap one config line."

RIGHT CARDS: Upper — card "PROCESS = WORKER": box "Bun Worker" containing "process (UUID)" with fds 0=recv, 1=send, 2=warn. Arrows labeled "postMessage" to "kernel". Lower — card "FIRMWARE": "TypeScript → bun build --compile → single binary → boots HAL → EMS → VFS → Kernel → Gateway. It IS the operating system."

BOTTOM: Amber rule with text: "NO BUN OUTSIDE HAL — if it touches Bun, it lives in src/hal/. Everything above is platform-independent."

Faint cyan margin scribbles: "init() and shutdown() on every device", "BunHAL aggregates all 17 into one injectable dependency", "all async/await — no sync I/O".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
