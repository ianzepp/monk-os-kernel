# Slide 2: HAL — Hardware Abstraction Layer

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Layout: Device Interface Catalog with Bus Architecture

## Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a hardware datasheet showing every device interface on a system bus.

TOP: Bold hand-lettered "2. HAL — HARDWARE ABSTRACTION LAYER" in white with amber double underline. Cyan subtitle: "17 device interfaces. one injectable dependency. every Bun primitive wrapped."

MAIN AREA — DEVICE CATALOG: A large system bus backbone runs horizontally across the center — a thick white line with evenly spaced tap points. 17 device modules hang off the bus, arranged in three rows above and below. Each device is a small standardized rectangle with its name and a tiny icon inside:

Top row (storage/data): "BlockDevice" with disk icon, "StorageEngine" with cylinder, "FileDevice" with folder, "JsonDevice" with braces, "YamlDevice" with indent lines, "RedisDevice" with diamond.

Middle row (on the bus line, network/protocol): "NetworkDevice" with antenna, "ChannelDevice" with bidirectional arrows, "DNSDevice" with globe, "CompressionDevice" with squeeze arrows, "IPCDevice" with shared-memory grid.

Bottom row (system/utility): "TimerDevice" with clock, "ClockDevice" with stopwatch, "EntropyDevice" with dice, "CryptoDevice" with lock, "ConsoleDevice" with terminal, "HostDevice" with escape arrow.

Each device connects to the central bus with a thin vertical trace. The bus is labeled "BunHAL" in amber at its center — the single aggregator class.

LEFT SIDE: A pinned amber card titled "UNIFORM CONTRACT" showing the shared interface in a small code-sketch box: "interface Device { init(): Promise<void>, shutdown(): Promise<void> }". Below: "every device follows the same lifecycle. BunHAL.init() initializes all 17. BunHAL.shutdown() tears them all down. one call."

RIGHT SIDE: A pinned card titled "TESTABILITY" showing two parallel paths. Left path: "production: BunHAL → real Bun primitives". Right path: "testing: MockHAL → in-memory stubs". Bold annotation: "kernel code is identical in both. HAL is the only seam." Below: a small sketch of a test file icon with checkmark.

BOTTOM LEFT: A pinned card titled "STORAGE ENGINES" with three rows: "MemoryStorageEngine — ephemeral, tests, O(1) KV", "BunStorageEngine — SQLite, WAL mode, single-node", "PostgresStorageEngine — distributed, MVCC, multi-node". Below: "all implement StorageEngine. swap via one config field."

BOTTOM RIGHT: A pinned card titled "POSIX ERRORS" listing error types in a column: "ENOENT, EACCES, EBADF, EINVAL, EEXIST, ENOTDIR, EISDIR, ENOSPC, ETIMEDOUT, EIO". Annotation: "typed errors from hal/errors.ts — never new Error()."

Faint cyan margin scribbles: "all ops async/await — no sync anywhere", "naming: POSIX for I/O, domain-specific elsewhere", "ChannelDevice handles HTTP, WebSocket, PostgreSQL, SQLite protocols".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
