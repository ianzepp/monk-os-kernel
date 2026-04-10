# Slide 8: Gateway & SDK — External Access

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Layout: Wire Protocol with Virtual Process Isolation

## Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a network protocol diagram — wire formats, connection flows, and isolation boundaries.

TOP: Bold hand-lettered "8. GATEWAY & SDK — EXTERNAL ACCESS" in white with amber double underline. Cyan subtitle: "MessagePack over Unix socket. virtual process per connection. no Worker overhead."

MAIN AREA — CONNECTION ARCHITECTURE: A large diagram showing the boundary between external and internal. A bold vertical amber dashed line divides the slide into "EXTERNAL" (left) and "KERNEL" (right).

Left side: Three external application boxes labeled "App A", "App B", "App C", each with a small code snippet icon showing "OSClient" inside. Arrows from each app converge on a Unix socket icon at the boundary line, labeled "/tmp/monk.sock" or "port 7778 (TCP) / 7779 (WebSocket)".

Right side: The socket connects to a large "Gateway" box. Inside Gateway, three virtual process boxes (one per connection) each with its own fd table sketch (small numbered slots 0-255), cwd label, and env label. Annotation: "each connection gets an isolated virtual process — own fd table, own cwd, own env. NO Worker thread per connection." The word "NO Worker" is emphasized in amber.

From each virtual process, an arrow leads to "dispatcher.execute()" which connects rightward to the full kernel stack (shown as a faint miniature of the layer diagram from the title slide).

UPPER RIGHT — WIRE PROTOCOL: A pinned card titled "WIRE FORMAT" showing the binary frame structure drawn as a horizontal byte diagram: "[4-byte big-endian length][MessagePack payload]". Below, request format: "{ id: 'abc', call: 'file:open', args: ['/etc/hosts', { read: true }] }". Response format: "{ id: 'abc', op: 'ok', data: { fd: 3 } }". Binary response: "{ id: 'abc', op: 'data', bytes: Uint8Array }". Annotation: "MessagePack — binary, not JSON. native Uint8Array for data ops."

LOWER LEFT — SDK USAGE: A pinned card titled "os-sdk CLIENT" with a small code sketch: "const client = new OSClient()", "await client.connect({ socketPath: '/tmp/monk.sock' })", "const fd = await client.open('/etc/hosts', { read: true })", "const data = await client.read(fd)", "await client.close(fd)". Annotation: "TypeScript SDK handles MessagePack encoding and stream protocol automatically."

LOWER RIGHT — MULTIPLEXING: A pinned card titled "CONCURRENT STREAMS" showing a diagram of multiple interleaved syscalls over one connection. Three parallel timelines labeled "stream A (file:read)", "stream B (ems:select)", "stream C (proc:spawn)". Responses arrive interleaved, each tagged with stream ID. Annotation: "multiple concurrent syscalls per connection. responses routed by stream ID. same backpressure protocol as internal Workers."

BOTTOM: An amber-outlined summary bar spanning full width: "EXTERNAL APPS → Unix socket → MessagePack → Gateway → virtual process → dispatcher → kernel. Same syscalls. Same streaming. Same backpressure. Zero Worker overhead per connection."

Faint cyan margin scribbles: "Gateway runs in kernel context, not as a Worker", "virtual processes share kernel handle table", "~50,000 ops/sec gateway throughput".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
