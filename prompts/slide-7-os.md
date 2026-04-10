# Slide 7: OS — Public API & Boot Sequence

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Layout: State Machine with Boot Timeline and Usage Modes

## Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a system startup sequence diagram — state transitions, initialization phases, and operational modes.

TOP: Bold hand-lettered "7. OS — PUBLIC API & BOOT SEQUENCE" in white with amber double underline. Cyan subtitle: "the entry point. 11-step boot. three operational modes."

UPPER LEFT — STATE MACHINE: A large state diagram with five states drawn as circles. "created" (initial, small dot) → "booting" (amber pulse animation lines) → "booted" (large, bold, prominent) → "shutdown" (dimmed). A branching failure path: "booting" → "failed" (with X mark). A return arrow from "shutdown" back to "created" labeled "can boot again". Each transition is labeled: "boot()" on the forward path, "shutdown()" leaving booted, "error" to failed. The "booted" state is drawn largest with radiating stability lines.

UPPER RIGHT — THREE MODES: Three operational mode diagrams stacked vertically, each a small scenario sketch:

"HEADLESS" — a box labeled "your app" with a small Monk OS box inside. Arrows show "boot() → use syscalls → shutdown()". Annotation: "you own the process. Monk OS is a library."

"HYBRID" — two parallel boxes: "your app" and "init Worker". Both active simultaneously. Annotation: "boot({ main: '/app/init.ts' }). init runs in a Worker, your code continues."

"TAKEOVER" — a single large box labeled "Monk OS" filling the space, with "your app" completely inside. Annotation: "exec() — never returns. the binary IS the OS. bun build --compile path."

CENTER — BOOT TIMELINE: A large horizontal timeline arrow spanning the full width, dominating the middle of the slide. Eleven numbered waypoints with vertical tick marks, each labeled:

1. "HAL init" — chip icon. 2. "EMS init" — pipeline icon. 3. "Auth init" — lock icon. 4. "LLM init" — brain icon. 5. "VFS init" — tree icon. 6. "mkdir /app /bin /etc /home /tmp /usr /var /vol" — folder icons. 7. "ROM copy" — arrow from disk to VFS. 8. "load mounts" — mount icon. 9. "Kernel init" — gear icon, "creates PID 1, mounts /proc". 10. "Dispatch init" — switch icon. 11. "Gateway + Kernel.boot()" — antenna icon, "activates services, starts tick".

The timeline has subtle phase brackets: steps 1-5 bracketed as "infrastructure", 6-8 as "filesystem", 9-11 as "runtime". Each bracket in amber.

BOTTOM LEFT — OS CLASS: A pinned card titled "OS CLASS API" with a condensed interface sketch: "boot(), exec(), shutdown()", "syscall(name, ...args)", "syscallStream(name, ...args)", "spawn(), kill(), mount()", "read(), text(), copy()". Annotation: "convenience wrappers delegate to syscall layer. all execute as init process."

BOTTOM RIGHT — SERVICE ACTIVATION: A pinned card titled "6 ACTIVATION TYPES" listing: "boot — start on kernel boot", "manual — explicit start only", "tcp:listen — socket activation", "udp:bind — datagram activation", "pubsub:subscribe — topic activation", "fs:watch — file event activation". Annotation: "services discovered from /etc/services/, /usr/*/etc/services/, /app/*/service.json."

Faint cyan margin scribbles: "config: storage type, env vars, path aliases, ROM path", "OSConfig → { storage: 'memory' | 'sqlite' | 'postgres' }", "isBooted() guard on all public methods".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
