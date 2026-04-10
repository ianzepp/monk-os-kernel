# Slide 6: Dispatch — Syscall Routing & Backpressure

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Layout: Switch Router with Stream Protocol

## Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a routing and flow-control schematic — message paths, fan-out, and backpressure gauges.

TOP: Bold hand-lettered "6. DISPATCH — SYSCALL ROUTING" in white with amber double underline. Cyan subtitle: "switch-based O(1) routing. 10 domains. streaming backpressure protocol."

UPPER HALF — ROUTING DIAGRAM: A large fan-in/fan-out diagram. On the left, multiple incoming arrows labeled with syscall prefixes: "file:*", "ems:*", "net:*", "proc:*", "handle:*", "pool:*", "hal:*", "auth:*", "llm:*", "sigcall:*". All arrows converge into a central hexagonal switch box labeled "Dispatcher" with "switch(name)" inside. From the switch, ten outgoing arrows fan right to domain handler boxes:

"vfs.ts — file:*, fs:*", "ems.ts — ems:*", "hal.ts — net:*, port:*, channel:*", "process.ts — proc:*, activation:*", "handle.ts — handle:*, ipc:*", "pool.ts — pool:*, worker:*", "sigcall.ts — sigcall:*", "auth.ts — auth:*", "llm.ts — llm:*", "debug.ts — debug:*".

Above the switch: annotation "O(1) lookup — switch statement, not map traversal". Below: "dispatcher sits OUTSIDE kernel — receives (kernel, vfs, ems, hal) as dependencies."

LOWER LEFT — SIGCALL PATH: A branching diagram from the Dispatcher. When a syscall name is unknown, a dashed arrow branches downward labeled "not found in switch?". It leads to a "Sigcall Registry" box that checks for a registered userspace handler. If found: arrow to "route to userspace process". If not: arrow to "yield error('ENOSYS')". Annotation: "userspace can register custom syscall handlers — extensible without kernel modification."

LOWER RIGHT — BACKPRESSURE PROTOCOL: A detailed stream flow diagram. A vertical timeline showing the exchange between "Kernel" (left) and "Worker" (right):

Kernel sends "Response (item)" rightward → Worker receives. Kernel sends more items → a queue fills. At "HIGH_WATER = 1000 items" a red/amber warning marker, kernel pauses. Worker sends "stream_ping" leftward → kernel checks queue depth. At "LOW_WATER = 100" kernel resumes. A separate branch shows "no ping for 5000ms → STALL → stream aborted".

Below the timeline: "StreamController wraps every syscall execution. syscall-controller for kernel→user. sigcall-controller for user→kernel."

BOTTOM: A pinned amber card titled "SYSCALL PATTERN" with a small code sketch: "async function* fileOpen(proc, kernel, vfs, path, flags): AsyncIterable<Response>". Annotations: "always async generator", "proc always first argument", "yield errors, never throw", "dependencies passed explicitly — no context object."

Faint cyan margin scribbles: "PING_INTERVAL = 100ms", "cancellation via stream_cancel message", "each concurrent syscall gets unique stream ID".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
