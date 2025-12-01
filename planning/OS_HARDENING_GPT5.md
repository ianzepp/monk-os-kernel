# OS Hardening (GPT‑5 Review)

End‑to‑end security and hardening review of the Monk OS kernel, VFS, HAL, and ROM libraries with a focus on `@src/` and `@rom/`.

This document complements `planning/OS_HARDENING.md` by:
- Confirming protections now present in the codebase.
- Calling out remaining gaps and tradeoffs.
- Proposing concrete implementation steps and priorities.

Review date: 2025‑12‑01
Reviewer: GPT‑5 (Claude)
Scope: `src/` (kernel, vfs, hal, process) and `rom/` (lib/, etc/)

---

## 1. Architectural Snapshot

Key properties (as currently implemented):

- HAL is a narrow adapter over Bun (`src/hal/**`)
  - Files, network, timers, entropy, crypto exposed as explicit interfaces.
  - Kernel code does not call Bun APIs directly.
- Kernel is the only component that:
  - Talks to HAL.
  - Manages processes and syscalls (`src/kernel/kernel.ts`, `src/kernel/syscalls.ts`).
- VFS is the capability/ACL layer (`src/vfs/**`)
  - ACLs are enforced at open time, handles are capabilities.
  - Host mounts are opt‑in and default to read‑only.
- Userland (`src/process/**`, `rom/lib/**`)
  - Uses typed syscall wrappers.
  - Has no direct access to host FS or host network; all goes through kernel.

This is a good foundation: the main security work now is tightening edges, defaults, and resource limits.

---

## 2. Confirmed Protections

These protections are present in the current code and match earlier hardening goals.

### 2.1 VFS and ACLs

- Root entity initialization (`src/vfs/vfs.ts:83-108`):
  - Root entity created with model `folder` and owner `ROOT_ID`.
  - Root ACL grants `*` the ops `['read', 'list', 'stat', 'create']` and no denies.
- ACL enforcement (`src/vfs/vfs.ts:651-666`):
  - Kernel bypass: caller `"kernel"` skips ACL checks.
  - For other callers, ACL is fetched per entity.
  - `checkAccess()` is invoked for both the caller ID and `"*"` (public grants) per op.
- Default ACLs for new entities (`src/vfs/acl.ts:103-108`, `src/vfs/vfs.ts:632-633`):
  - Creator gets `['*']` on new entities, others get no access unless explicitly granted.

### 2.2 Path Normalization and Traversal Protection

- VFS `normalizePath()` (`src/vfs/vfs.ts:545-559`):
  - Splits on `/`, filters empty segments, resolves `.` and `..`.
  - Never goes above root (`..` at root is ignored).
  - Returns canonical absolute paths (`/foo/bar`).
- Host mounts (`src/vfs/mounts/host.ts:46-61, 68-89`):
  - `createHostMount` resolves a mount root to an absolute `resolvedHostPath`.
  - `resolveHostPath` ensures any path under the mount, when resolved, still starts with `resolvedHostPath`; otherwise returns `null` (path traversal attempt).

### 2.3 Host Mount Safety

- Host mounts default to read‑only (`src/vfs/mounts/host.ts:57-59`).
- `hostOpen` (`src/vfs/mounts/host.ts:184-223`):
  - Denies writes on read‑only mounts with `EACCES`.
  - Refuses to open directories for file I/O (throws `EISDIR`).
  - Does not implement write support even for writable mounts yet (explicit `EACCES`).

### 2.4 Resource Limits and Backpressure

- Per‑process caps (`src/kernel/kernel.ts`):
  - `MAX_FDS` enforced in `openFile` and `createPipe` (`1121-1127`, `1207-1213`).
  - `MAX_PORTS` enforced in `createPort` (`1299-1303`).
  - `MAX_CHANNELS` enforced in `openChannel` (`1485-1503`).
- Pipe backpressure (`src/kernel/resource.ts:680-707, 713-739`):
  - `PipeBuffer` has `PIPE_BUFFER_HIGH_WATER = 64 * 1024` (64KB) and throws `EAGAIN` when exceeded.
  - Shared buffer also handles EOF and closed‑end semantics.
- ROM `ByteWriter` backpressure (`rom/lib/io.ts:207-260, 328-352`):
  - High‑water mark (`BYTE_WRITER_HIGH_WATER = 64KB`).
  - `full` flag and `waitForDrain()` primitive for producers.

### 2.5 Syscall Validation and Timeouts

- Input validation via `validate.ts` (`src/kernel/kernel.ts:123-152, 195-205, 208-231`):
  - `spawn`, `exit`, `kill`, `wait`, redirect and worker syscalls validate string/number arguments using `assertString`, `assertNonNegativeInt`, etc.
- `wait()` timeout support (`src/kernel/kernel.ts:521-571`):
  - Optional `timeout` arg; when provided and positive, `wait` races the child’s exit against a timeout.
  - On timeout, rejects with `ETIMEDOUT`.

Overall, the core architecture and most of the high‑risk resource issues from `OS_HARDENING.md` (K‑001, K‑002, K‑003, K‑005, K‑007, K‑008, K‑010) are already addressed in code.

---

## 3. Remaining Issues and Recommendations

The issues below are grouped by severity (High/Medium/Low) and given new IDs of the form `G‑###` to avoid confusion with historical K‑IDs.

### 3.1 High: Network Service Exposure

**ID**: G‑001

**Summary**: Default telnet/HTTP services can bind to all interfaces without explicit opt‑in.

**Details**:

- Service definitions:
  - `rom/etc/services/httpd.json`: HTTP server on TCP port 8080.
  - `rom/etc/services/telnetd.json`: Telnet server on TCP port 2323.
- Kernel activation paths:
  - `activateService` for `tcp:listen` uses:
    ```ts
    const listener = await this.hal.network.listen(activation.port, {
        hostname: activation.host,
    });
    ```
    (`src/kernel/kernel.ts:1679-1688`)
  - `BunNetworkDevice.listen` constructs a `BunListener` which defaults hostname to `'0.0.0.0'` (`src/hal/network.ts:347-351`).

**Risk**:

- In a production or containerized environment, this means telnet and HTTP may be reachable from outside the host by default, exposing:
  - Plaintext shell access via telnet.
  - Whatever HTTP functionality `httpd` implements.
- This contradicts the implicit “developer‑local” assumptions in `src/boot.ts` and the `nc localhost 2323` message.

**Recommended fix**:

1. Change default binding for services without explicit `host` to loopback only.
   - In `activateService` (`src/kernel/kernel.ts`), when `activation.type === 'tcp:listen'` and `activation.host` is undefined, set `hostname: '127.0.0.1'` in the call to `network.listen`.
   - Optionally allow `activation.host` to be configured via `/etc/services/*.json` for non‑local exposures.
2. Make telnet service clearly opt‑in:
   - Keep `seedDefaultServices()` (`src/kernel/kernel.ts:1645-1656`) for development builds only, or behind a build‑time flag/`DEBUG` env check.
   - For production builds: do not write `/etc/services/telnetd.json` automatically; require an explicit service file.
3. Document service security:
   - Add a section in `OS_NETWORK.md` and `OS_SHELL.md` explaining:
     - Telnet is plaintext and should be used only in controlled dev environments.
     - Recommended patterns for exposing HTTP/TLS externally (e.g., behind a reverse proxy).

**Status**: Open (no code yet enforcing loopback-by-default or telnet opt‑in).

---

### 3.2 High: Ports & Queues – Blocking recv() and Unbounded Buffers

**ID**: G‑002

**Summary**: Port types (`ListenerPort`, `WatchPort`, `UdpPort`, `PubsubPort`) can block indefinitely on `recv()` and use unbounded `messageQueue` / `waiters` arrays.

**Details**:

- ListenerPort (`src/kernel/resource.ts:249-270`):
  - `recv()` calls `listener.accept()` and returns a socket; no timeout or cancellation.
- WatchPort (`src/kernel/resource.ts:305-312, 330-365, 374-393`):
  - Maintains `messageQueue: PortMessage[]` and `waiters: Array<(msg) => void>`.
  - `recv()`:
    - If queue has messages → shift and return.
    - Else if iterator done → throw `Error('EOF: No more events')`.
    - Else → push a resolver into `waiters` with no limit or timeout.
- UdpPort (`src/kernel/resource.ts:439-452, 468-81, 489-503`):
  - Uses `messageQueue` and `waiters` similarly.
  - `startListening` enqueues as fast as datagrams arrive; no cap on queued messages.
- PubsubPort (`src/kernel/resource.ts:559-63, 83-96, 98-109`):
  - Same pattern of `messageQueue` + `waiters` with no bounds.
- `OS_HARDENING.md` acknowledges this as K‑004 (non‑cancellable recv) and K‑011 (unbounded waiters).

**Risks**:

- Availability/DoS:
  - An attacker generating many UDP packets or pubsub messages can grow memory by filling a port’s message queue faster than userland can consume it.
- Shutdown behavior:
  - Processes blocked in `recv()` cannot respond to SIGTERM gracefully; only SIGKILL eventually terminates them.
  - Worker shutdown might leave blocked `recv()` promises that never resolve cleanly.

**Recommended fix** (two phases):

1. Introduce bounded queues per port.
   - Add constants (e.g. in `src/kernel/types.ts` or `src/kernel/resource.ts`):
     - `PORT_QUEUE_HIGH_WATER` (e.g. 1024 messages or some byte threshold).
   - In each port’s enqueue path:
     - If `waiters.length > 0` → deliver immediately (no queue growth).
     - Else if `messageQueue.length >= PORT_QUEUE_HIGH_WATER`:
       - Either drop the message (with a debug log) or throw/log an `EAGAIN` from a kernel perspective.
       - For UDP, dropping is acceptable; for pubsub/watch, logging and dropping is likely better than unbounded growth.
   - For `waiters`, consider bounding the list; if too many waiters accumulate, fail new `recv()` calls with `EAGAIN` or `ETIMEDOUT`.

2. Add cancellation/timeout to `Port.recv()`.
   - Extend the `Port` interface to `recv(signal?: AbortSignal): Promise<PortMessage>`.
   - In each implementation:
     - If `signal?.aborted` at entry, reject with `ECANCELED`.
     - When pushing a waiter, also attach an abort listener that removes the waiter and rejects.
   - In the kernel’s `recvPort` path (`src/kernel/kernel.ts:1418-1458`):
     - Pass an `AbortSignal` tied to the calling process’ active streams map or to a per‑syscall abort controller similar to `handleSyscall`.
   - When a process is terminated or a stream is cancelled, abort the signals so blocked `recv()` calls resolve quickly.

**Status**: Open; design is understood and documented in `OS_HARDENING.md`, but no port‑level backpressure or abort support is implemented yet.

---

### 3.3 Medium: chdir Validation

**ID**: G‑003

**Summary**: `chdir` syscall changes `proc.cwd` without verifying that the path exists and is a directory.

**Details**:

- `createMiscSyscalls().chdir` (`src/kernel/syscalls.ts:371-379`):
  ```ts
  async *chdir(proc: Process, path: unknown): AsyncIterable<Response> {
      if (typeof path !== 'string') {
          yield respond.error('EINVAL', 'path must be a string');
          return;
      }
      // TODO: Verify path exists and is a directory
      proc.cwd = path;
      yield respond.ok();
  }
  ```

**Risks**:

- Correctness: processes can set cwd to invalid or non‑directory paths.
- Security: while ACLs are enforced when opening paths, a bogus cwd can make path reasoning harder and might interact poorly with tools that assume cwd is real.

**Recommended fix**:

- Update `chdir` to use VFS for validation before changing cwd:
  - Normalize path relative to current cwd (consistent with `process` library’s path utilities).
  - Call `vfs.stat()` with caller ID and catch errors.
  - Require `model === 'folder'`; otherwise return `ENOTDIR`.
- Implementation sketch:
  - Inject `vfs` into `createMiscSyscalls` (signature change) or add a small wrapper in `Kernel` that holds vfs and registers a `chdir` syscall that calls `vfs.stat()`.
  - Ensure recursion/ordering is clear so this doesn’t create a circular dependency.

**Status**: Open; marked as K‑012 in `OS_HARDENING.md` and still unimplemented.

---

### 3.4 Medium: EOF Semantics Coupled to Resource Type

**ID**: G‑004

**Summary**: The `read` syscall’s EOF detection inspects `resource.type` instead of leaving EOF semantics to the resource implementation.

**Details**:

- `createFileSyscalls().read` (`src/kernel/syscalls.ts:151-171`):
  ```ts
  const chunk = await resource.read(size);
  // EOF
  if (chunk.length === 0) {
      break;
  }
  // ...
  if (resource.type === 'file' && chunk.length < size) {
      break;
  }
  ```
- `OS_HARDENING.md` flags this as K‑006: resource‑type leakage into syscall semantics.

**Risks**:

- When new resource types are introduced, syscall code must be updated; missing cases can cause:
  - Premature EOF (short reads treated as EOF where they shouldn’t be).
  - Infinite loops or hangs (EOF never detected).

**Recommended fix**:

- Move EOF semantics into the resource layer:
  - Option A: extend `Resource` with a `readExactly(size)` and `isEOF()` method.
  - Option B: define conventions per resource type:
    - `read()` returns `Uint8Array` and 0‑length always means EOF for that resource.
    - For streaming resources that may return short reads, they should internally buffer until they meet the requested size or reach EOF.
  - Then remove explicit checks against `resource.type` from `createFileSyscalls().read`.
- As a transitional step, add a comment and a guard to fail fast if an unexpected resource type is encountered instead of silently misbehaving.

**Status**: Open; design is documented in `OS_HARDENING.md`, but current code still branches on `resource.type`.

---

### 3.5 Medium: `ByteWriter` Usage Patterns

**ID**: G‑005

**Summary**: `ByteWriter` in `rom/lib/io.ts` supports backpressure but relies on cooperative usage; misuse can still cause process‑local memory growth.

**Details**:

- `ByteWriter` (`rom/lib/io.ts:207-260, 328-384`):
  - Maintains `queuedBytes` and a `highWaterMark`.
  - Exposes `full` and `waitForDrain()`.
  - `write()` throws if called after `end()` but otherwise happily buffers until `queuedBytes` grows, only signaling backpressure via `full`.

**Risks**:

- If scripts ignore `full` and never `await waitForDrain()`, they can produce unbounded data and accumulate `chunks` before consumers drain them.
- This doesn’t break kernel invariants but can OOM an individual worker process.

**Recommended fix**:

- Clarify and enforce usage:
  - In any core ROM scripts that use `ByteWriter`, adopt the documented pattern:
    ```ts
    if (writer.full) {
        await writer.waitForDrain();
    }
    writer.write(chunk);
    ```
- Optionally add a hard cap:
  - Add an optional constructor parameter `maxTotalBytes?: number` and, if exceeded, throw a clear error.
  - Use this for internal tooling where unbounded streaming is not desired.

**Status**: Acceptable as‑is for trusted scripts; recommend disciplined usage for OS‑shipped scripts.

---

### 3.6 Medium: Shell Tokenizer Trailing Escape

**ID**: G‑006

**Summary**: The shell tokenizer in `rom/lib/shell/parse.ts` silently drops a trailing backslash.

**Details**:

- `tokenize()` (`rom/lib/shell/parse.ts:73-88, 111-117`):
  - Tracks `escape` state when encountering `\`.
  - If input ends with `\`, `escape` remains true but there is no post‑loop handling; the backslash is effectively ignored.
- `OS_HARDENING.md` tracks this as K‑013.

**Risks**:

- UX / correctness issue:
  - `echo test\` produces `"test"` instead of `"test\"` or a parse error.
- Not a direct security vulnerability, but could surprise users or tooling relying on literal backslashes.

**Recommended fix**:

- After the loop in `tokenize()`:
  - If `escape` is still true:
    - Either append a literal `\` to `current` and then push it as a token, or
    - Treat it as a syntax error and have `parseCommand` return `null` or throw.
- For a POSIX‑like shell UX, treating trailing `\` as a literal in some contexts or as an incomplete command (prompting for continuation) would be ideal. For Monk, a simple error + clear message is likely sufficient.

**Status**: Open; minor but easy to fix.

---

### 3.7 Low: Network Error Typing in HAL

**ID**: G‑007

**Summary**: Some network timeouts/errors in `BunNetworkDevice` are surfaced as generic `Error` instances, not as HAL errors with codes.

**Details**:

- `connect` timeout (`src/hal/network.ts:245-307`):
  - Uses `setTimeout` to reject with `new Error('Connection timeout')`.
- `BunSocket.read` timeout (`src/hal/network.ts:488-503`):
  - Rejects with `new Error('ETIMEDOUT: Read timeout')`.

**Risks**:

- Callers that expect HAL error codes (`ETIMEDOUT`, `ECONNREFUSED`, etc.) may have to parse error messages, which is brittle.
- Logging and metrics become less structured.

**Recommended fix**:

- Use HAL error types from `src/hal/errors.ts` or `fromSystemError`:
  - Replace raw `new Error('…')` with `new ETIMEDOUT('…')` or map to a HAL error using a helper.
- Ensure all externally observable network errors carry a `code` property consistent with the rest of HAL.

**Status**: Low priority but good for consistency and observability.

---

### 3.8 Low: Host Handle IDs Use Date.now()

**ID**: G‑008

**Summary**: `HostFileHandle.id` includes `Date.now()` as part of the identifier.

**Details**:

- `HostFileHandle` (`src/vfs/mounts/host.ts:238-243`):
  ```ts
  this.id = `host-handle:${vfsPath}:${Date.now()}`;
  ```

**Risks**:

- Very minor; this ID is internal to the VFS host handle implementation.
- Weakly time‑based IDs can be harder to correlate deterministically in tests.

**Recommended fix** (optional):

- Use `hal.entropy.uuid()` when available, or a monotonic counter specific to host handles.

**Status**: Cosmetic; no security impact.

---

## 4. Implementation Plan

A suggested incremental plan for addressing the above issues:

### Phase A – External Attack Surface

- [ ] G‑001: Service binding and telnet opt‑in
  - Default `tcp:listen` services to `127.0.0.1` when `activation.host` is not specified.
  - Gate `seedDefaultServices()` so `telnetd` is not auto‑enabled in production builds.
  - Update `OS_NETWORK.md` and `OS_SHELL.md` to document recommended patterns.

### Phase B – Port and Queue Safety

- [ ] G‑002: Ports & queues
  - Add queue high‑water marks and drop/delay behavior for `WatchPort`, `UdpPort`, `PubsubPort`.
  - Introduce optional `AbortSignal` to `Port.recv()` and wire it through the kernel’s `recv` syscall.
  - Ensure process termination aborts outstanding `recv()` calls.

### Phase C – Correctness and UX

- [ ] G‑003: `chdir` validation
  - Update `chdir` syscall to verify path exists and is a folder via VFS.
- [ ] G‑004: EOF semantics
  - Introduce a more explicit EOF contract on `Resource` and simplify `read` syscalls.
- [ ] G‑006: Shell tokenizer trailing escape
  - Add post‑loop handling for `escape` in `tokenize()`.

### Phase D – Observability and Polish

- [ ] G‑005: `ByteWriter` usage guidance
  - Audit OS‑shipped scripts using `ByteWriter` to ensure they respect `full` and `waitForDrain()`.
  - Optionally add a hard maximum byte cap.
- [ ] G‑007: Network error typing
  - Wrap connect/read timeouts in HAL error types with consistent `code` values.
- [ ] G‑008: Host handle IDs
  - Optionally switch to UUIDs or monotonic counters.

---

## 5. Notes on Testing

For each change, recommended tests:

- G‑001 (services):
  - Verify that `telnetd` and `httpd` bind to `127.0.0.1` by default.
  - Add a service definition with explicit `host` and verify binding externally.
- G‑002 (ports & queues):
  - Stress tests for UDP and pubsub where producer outpaces consumer; assert memory does not grow unbounded and that either drops or backpressure occur.
  - Tests for aborting `recv()` when process is signalled or stream is cancelled.
- G‑003 (chdir):
  - Ensure `chdir` to non‑existent or non‑directory path fails with `ENOENT`/`ENOTDIR` and leaves `cwd` unchanged.
- G‑004 (EOF semantics):
  - Regression tests around short reads for files, pipes, and sockets to ensure EOF behavior is consistent.
- G‑006 (tokenizer):
  - Cases like `echo test\`, `echo "foo\\"`, etc., verifying token sequences.
- G‑007 (HAL errors):
  - Simulate timeouts and connection failures and assert `error.code === 'ETIMEDOUT'` or another expected code.

---

This document is intended to be a living companion to `OS_HARDENING.md`. As you implement the fixes above, consider updating both documents with:
- Checkboxes and dates for completed items.
- Pointers to relevant tests and scenarios under `src-spec/` or `api-spec/`.
