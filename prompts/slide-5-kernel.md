# Slide 5: Kernel — Process & Handle Management

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Layout: Process Model with Handle Architecture

## Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a kernel internals diagram — process state machines, handle tables, and message flow.

TOP: Bold hand-lettered "5. KERNEL — PROCESS & HANDLE MANAGEMENT" in white with amber double underline. Cyan subtitle: "UUID processes in Workers. unified handles. capability-based permissions."

UPPER LEFT — PROCESS MODEL: A large process state machine diagram. Four state circles connected by labeled arrows: "starting" → "running" → "stopped" → "zombie". The "running" state is drawn larger and bolder. Inside each state, a small icon (gear spinning, gear solid, gear stopped, skull). Arrows labeled: "Worker ready" (starting→running), "SIGTERM / exit()" (running→stopped), "parent collects" (stopped→zombie). A side annotation shows the process structure: "UUID identity (not integer PID)", "Bun Worker with isolated heap", "fds 0-255 mapped to handle UUIDs", "standard: 0=recv, 1=send, 2=warn".

UPPER RIGHT — HANDLE ARCHITECTURE: Six handle type blocks arranged in a grid, each a small labeled module with an icon and one-line description:

"file" — folder icon, "VFS files, folders, devices". "socket" — plug icon, "TCP connections". "pipe" — tube icon, "message-based inter-process". "port" — antenna icon, "listeners, watchers, pubsub". "channel" — protocol icon, "HTTP, WebSocket, PostgreSQL". "process-io" — arrow icon, "service I/O routing".

All six connect upward to a shared interface bar labeled "Handle { exec(msg) → AsyncIterable<Response>, close() }" in amber. Annotation: "one interface for all I/O. the handle IS the capability — if you have it, you have permission."

CENTER — MESSAGE FLOW: A horizontal flow diagram showing a process communicating with the kernel. Left: a process box with "postMessage(syscall)" arrow rightward. Center: kernel box receives, routes to handle table, executes. Right: "AsyncIterable<Response>" streams back. Labels on the response stream: "ok | error | item | data | event | progress | done | redirect — 8 response ops."

BOTTOM LEFT — WORKER POOLS: A diagram showing a pool as a container of worker slots. Label "PoolManager" at top with two pool boxes: "freelance (min:2, max:32)" and "compute (min:4, max:64)". Small worker rectangles fill slots, some active (solid), some idle (dashed). Arrows show "lease → use → release" cycle. Annotation: "auto-scaling, idle timeout, backpressure queue when exhausted."

BOTTOM RIGHT — PORT TYPES: A pinned card listing the five port types: "tcp:listen — accept TCP connections", "udp:bind — UDP datagrams", "fs:watch — file event streams", "pubsub:subscribe — topic messaging", "signal:catch — signal handlers". Annotation: "ports yield messages via recv(). structured data, not byte streams."

Faint cyan margin scribbles: "message-pure: no JSON serialization inside kernel", "global handle table with reference counting", "SIGTERM for graceful, SIGKILL for immediate".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
