/**
 * gatewayd - Unix Socket Gateway Daemon
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * gatewayd is THE CRITICAL bridge between external applications and the Monk OS
 * kernel. It exposes the kernel's syscall interface over a Unix domain socket,
 * allowing any process (even those not running as Monk Workers) to interact
 * with the OS.
 *
 * Think of gatewayd as a message pipeline, similar to `cat | cat | cat`:
 *
 *   Unix socket in --> gatewayd --> syscallStream() --> Unix socket out
 *
 * External apps connect to /tmp/monk.sock (configurable via MONK_SOCKET env),
 * send JSON-encoded syscall requests, and receive streamed JSON responses.
 *
 * WIRE PROTOCOL (newline-delimited JSON)
 * ======================================
 *
 * Request (client -> gatewayd):
 *   { "type": "syscall", "id": "<uuid>", "name": "<syscall>", "args": [...] }
 *
 * Response (gatewayd -> client), one per stream item:
 *   { "type": "response", "id": "<uuid>", "result": { "op": "...", "data": {...} } }
 *
 * Error (transport-level failure):
 *   { "type": "response", "id": "<uuid>", "error": { "code": "...", "message": "..." } }
 *
 * The `id` field correlates responses to requests, enabling concurrent requests
 * with interleaved responses on the same connection.
 *
 * Response `op` values (from kernel Response type):
 *   - 'ok'       Terminal. Success with optional data.
 *   - 'error'    Terminal. Syscall failed.
 *   - 'done'     Terminal. Stream complete (after items).
 *   - 'redirect' Terminal. Follow redirect (symlinks, mounts).
 *   - 'item'     Non-terminal. One item in a sequence.
 *   - 'data'     Non-terminal. Binary data chunk (base64 encoded).
 *   - 'event'    Non-terminal. Async event notification.
 *   - 'progress' Non-terminal. Progress indicator.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: A client's activeStreams set contains exactly the stream IDs currently
 *        being processed for that client. Missing IDs = cleanup leak.
 *        VIOLATED BY: Throwing before adding to set, or not removing in finally.
 *
 * INV-2: Once state.disconnecting = true, no new syscalls are dispatched for
 *        that client. In-flight dispatches will exit gracefully.
 *        VIOLATED BY: Checking flag after dispatch starts.
 *
 * INV-3: Stream IDs within a client connection are unique. Duplicate IDs cause
 *        incorrect cancellation and response routing.
 *        VIOLATED BY: Client sending duplicate IDs (we warn but continue).
 *
 * INV-4: Binary data in responses is base64-encoded for JSON transport.
 *        VIOLATED BY: Raw Uint8Array serialization (produces object, not string).
 *
 * CONCURRENCY MODEL
 * =================
 * gatewayd runs as a Worker in the Monk OS process model. All JavaScript
 * execution is single-threaded within the Worker, but:
 *
 * - Multiple clients connect concurrently (each gets a ClientState)
 * - Each client can have multiple concurrent requests (fire-and-forget dispatch)
 * - syscallStream() crosses thread boundaries via postMessage to kernel
 * - The kernel runs in the main thread; gatewayd in a worker thread
 *
 * The async event loop interleaves the for-await loops naturally. No explicit
 * locking is needed because JavaScript is single-threaded, but we must be
 * careful about state changes across await points.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Write to closed socket
 *       MITIGATION: Check disconnecting flag AND catch write errors.
 *       After every await, the socket might be closed.
 *
 * RC-2: Duplicate stream IDs from client
 *       MITIGATION: Log warning but continue. IDs are client-provided and
 *       we can't guarantee uniqueness across clients.
 *
 * RC-3: Cleanup during active dispatch
 *       MITIGATION: cancelStream() signals abortion, dispatch loops check
 *       disconnecting flag and exit gracefully. Write errors are caught.
 *
 * BACKPRESSURE
 * ============
 * Backpressure flows naturally end-to-end:
 *
 *   1. Client can't read from socket fast enough
 *   2. gatewayd's write() blocks (Bun's socket buffer fills)
 *   3. gatewayd's for-await loop stalls (waiting on write)
 *   4. syscallStream() iterator stalls (waiting for next() call)
 *   5. Kernel pauses at HIGH_WATER mark (no ping from gatewayd)
 *
 * No explicit backpressure handling needed - the async pipeline self-regulates.
 *
 * SECURITY CONSIDERATIONS
 * =======================
 * - Unix socket permissions control access (filesystem permissions on socket file)
 * - All clients currently share gatewayd's process context (handle table, cwd, env)
 * - No authentication beyond socket access
 * - TODO: Virtual process isolation (see below)
 *
 * TODO: Virtual Process Isolation
 * ===============================
 * Currently all clients share gatewayd's process context (handle table, cwd, env).
 * For proper isolation, each connection should get a virtual process:
 *
 *   1. On connect: pid = await syscall('proc:create_virtual')
 *   2. On message: result = await syscall('proc:exec_as', pid, name, args)
 *   3. On disconnect: await syscall('proc:terminate', pid)
 *
 * This requires kernel support for virtual processes (process table entry
 * without a Worker). Until then, clients share state.
 *
 * @module svc/gatewayd
 */

// =============================================================================
// IMPORTS
// =============================================================================

import {
    listen,
    recv,
    read,
    write,
    close,
    unlink,
    println,
    eprintln,
} from '@rom/lib/process/index.js';
import { syscallStream, cancelStream } from '@rom/lib/process/syscall.js';
import type { Response } from '@rom/lib/process/types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default Unix socket path for client connections.
 * WHY: /tmp is world-writable and conventional for Unix sockets.
 * Override via MONK_SOCKET environment variable for testing or multi-instance.
 */
const SOCKET_PATH = process.env.MONK_SOCKET ?? '/tmp/monk.sock';

/**
 * Maximum concurrent streams per client.
 * WHY: Prevent resource exhaustion from runaway clients.
 * PERF: 100 is generous for normal use; adjust based on workload.
 */
const MAX_CONCURRENT_STREAMS = 100;

/**
 * Maximum read buffer size per client (1MB).
 * WHY: Prevent memory exhaustion from malformed input.
 */
const MAX_READ_BUFFER_SIZE = 1024 * 1024;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Per-connection client state.
 *
 * Each connected client gets an isolated state object tracking:
 * - Socket file descriptor for I/O
 * - Read buffer for incomplete messages (JSON lines may span chunks)
 * - Active stream tracking for cleanup on disconnect
 * - Disconnecting flag to prevent new work during shutdown
 *
 * LIFECYCLE:
 *   1. Created in accept loop when client connects
 *   2. Used by handleClient for message processing
 *   3. Cleaned up in handleClient's finally block
 *   4. Removed from clients Map after cleanup
 */
interface ClientState {
    /** Socket fd for this connection (from recv on listener) */
    socketFd: number;

    /**
     * Read buffer for incomplete messages.
     * WHY: TCP is a stream protocol; JSON messages may span multiple read() calls.
     * Messages are newline-delimited, so we accumulate until we see '\n'.
     */
    readBuffer: string;

    /**
     * Client identifier for logging.
     * WHY: Correlate log messages across the client's session.
     */
    clientId: string;

    /**
     * Active stream IDs for cancellation on disconnect.
     * INVARIANT: Contains exactly the IDs of in-flight dispatchSyscall calls.
     * WHY: On disconnect, we must cancel all pending syscalls to free resources.
     */
    activeStreams: Set<string>;

    /**
     * Whether client is disconnecting (stop accepting new requests).
     * WHY: Prevents new work during cleanup, allows graceful drain.
     * Once true, processMessage returns immediately without dispatching.
     */
    disconnecting: boolean;
}

/**
 * Wire protocol: Syscall request from client.
 */
interface SyscallRequest {
    type: 'syscall';
    id: string;
    name: string;
    args: unknown[];
}

// =============================================================================
// STATE
// =============================================================================

/**
 * Active clients indexed by socket fd.
 * WHY: Socket fd is unique and stable for the connection lifetime.
 * Used for debugging and potential future broadcast/admin features.
 */
const clients = new Map<number, ClientState>();

/**
 * Next client ID for logging.
 * WHY: Monotonically increasing IDs help trace client sessions in logs.
 */
let nextClientId = 1;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Encode binary data as base64 for JSON transport.
 *
 * WHY: JSON.stringify(Uint8Array) produces {"0":65,"1":66,...} which is
 * both wrong and huge. Base64 is standard for binary-in-JSON.
 *
 * @param bytes - Binary data to encode
 * @returns Base64-encoded string
 */
function encodeBase64(bytes: Uint8Array): string {
    // Bun provides btoa, but it expects a string. Convert via binary string.
    let binary = '';

    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
    }

    return btoa(binary);
}

/**
 * Prepare a Response for JSON serialization.
 *
 * WHY: Response objects may contain Uint8Array in the 'bytes' field.
 * We need to base64-encode these for wire transport.
 *
 * @param response - Kernel Response to serialize
 * @returns JSON-safe response object
 */
function prepareResponseForWire(response: Response): object {
    // Fast path: most responses don't have bytes
    if (!('bytes' in response) || !(response.bytes instanceof Uint8Array)) {
        return response;
    }

    // Clone and encode bytes as base64
    return {
        ...response,
        bytes: encodeBase64(response.bytes),
    };
}

/**
 * Safely write to a socket, handling disconnection.
 *
 * WHY: The socket may close at any time (client disconnect, network error).
 * We need to catch write errors gracefully rather than crashing the handler.
 *
 * @param state - Client state with socket fd
 * @param data - Data to write
 * @returns true if write succeeded, false if socket is dead
 */
async function safeWrite(state: ClientState, data: Uint8Array): Promise<boolean> {
    // RACE FIX: Check disconnecting before attempting write
    if (state.disconnecting) {
        return false;
    }

    try {
        await write(state.socketFd, data);

        return true;
    }
    catch (err) {
        // Socket closed or errored - mark as disconnecting to stop other streams
        state.disconnecting = true;

        return false;
    }
}

// =============================================================================
// WIRE PROTOCOL
// =============================================================================

/**
 * Send a syscall response to client.
 *
 * Forwards the Response object as-is (with bytes base64-encoded),
 * preserving the op field so clients can distinguish item/data/event/ok/error/done.
 *
 * WIRE FORMAT:
 *   { "type": "response", "id": "<request-id>", "result": <Response> }
 *
 * @param state - Client state
 * @param id - Request ID (correlates response to request)
 * @param result - Kernel Response to forward
 * @returns true if sent successfully, false if socket is dead
 */
async function sendResponse(state: ClientState, id: string, result: Response): Promise<boolean> {
    const wireResult = prepareResponseForWire(result);
    const message = JSON.stringify({
        type: 'response',
        id,
        result: wireResult,
    }) + '\n';

    return safeWrite(state, new TextEncoder().encode(message));
}

/**
 * Send a transport-level error to client.
 *
 * Used for errors that occur outside syscall execution:
 * - JSON parse errors
 * - Unknown message types
 * - Internal gatewayd errors
 *
 * WIRE FORMAT:
 *   { "type": "response", "id": "<request-id>", "error": { "code": "...", "message": "..." } }
 *
 * @param state - Client state
 * @param id - Request ID (or 'parse'/'unknown' for pre-ID errors)
 * @param code - Error code (POSIX-style: EINVAL, EIO, etc.)
 * @param message - Human-readable error description
 * @returns true if sent successfully, false if socket is dead
 */
async function sendError(state: ClientState, id: string, code: string, message: string): Promise<boolean> {
    const response = JSON.stringify({
        type: 'response',
        id,
        error: { code, message },
    }) + '\n';

    return safeWrite(state, new TextEncoder().encode(response));
}

// =============================================================================
// SYSCALL DISPATCH
// =============================================================================

/**
 * Dispatch a syscall on behalf of the client.
 *
 * ALGORITHM:
 * 1. Register stream ID for cancellation tracking
 * 2. Iterate syscallStream() responses
 * 3. Forward each response to client
 * 4. Exit on terminal op or disconnect
 * 5. Unregister stream ID in finally
 *
 * All syscalls are treated as streams - some yield one response (ok/error),
 * others yield many (item...item...done). gatewayd doesn't distinguish;
 * it forwards each Response as it arrives until a terminal op ends the stream.
 *
 * RACE CONDITIONS:
 * - Client may disconnect at any await point
 * - We check state.disconnecting after each response
 * - safeWrite handles socket errors gracefully
 *
 * CONCURRENCY:
 * - Multiple dispatchSyscall calls run concurrently for the same client
 * - Each has its own for-await loop
 * - JavaScript event loop interleaves them naturally
 *
 * @param state - Client state
 * @param id - Request ID for response correlation
 * @param name - Syscall name (e.g., 'file:open', 'fs:readdir')
 * @param args - Syscall arguments
 */
async function dispatchSyscall(
    state: ClientState,
    id: string,
    name: string,
    args: unknown[],
): Promise<void> {
    // INVARIANT CHECK: Warn on duplicate stream ID
    if (state.activeStreams.has(id)) {
        await eprintln(`gatewayd: ${state.clientId} duplicate stream ID: ${id}`);
        // Continue anyway - client's problem
    }

    // Track this stream for cancellation on disconnect
    state.activeStreams.add(id);

    try {
        for await (const response of syscallStream(name, ...args)) {
            // RACE FIX: Check disconnecting BEFORE writing
            // If disconnect happened during syscallStream yield, exit immediately
            if (state.disconnecting) {
                cancelStream(id);
                break;
            }

            // Forward response to client
            const sent = await sendResponse(state, id, response);

            if (!sent) {
                // Socket dead - cancel stream and exit
                cancelStream(id);
                break;
            }

            // Terminal ops end the stream
            if (response.op === 'ok' || response.op === 'error' ||
                response.op === 'done' || response.op === 'redirect') {
                break;
            }
        }
    }
    catch (err: unknown) {
        // Syscall stream threw an error (shouldn't happen normally -
        // errors should come as { op: 'error' } responses)
        const error = err as Error & { code?: string };

        // RACE FIX: Only send if not disconnecting
        if (!state.disconnecting) {
            await sendError(state, id, error.code ?? 'EIO', error.message);
        }
    }
    finally {
        // INVARIANT: Always remove from active streams
        state.activeStreams.delete(id);
    }
}

// =============================================================================
// MESSAGE PROCESSING
// =============================================================================

/**
 * Process a single syscall message from client.
 *
 * ALGORITHM:
 * 1. Parse JSON (send error on failure)
 * 2. Validate message type
 * 3. Check concurrency limits
 * 4. Fire-and-forget dispatch (allows concurrent requests)
 *
 * Fire-and-forget dispatch is intentional: we start the syscall but don't
 * await it. This allows the read loop to process the next request while
 * previous syscalls are still streaming responses.
 *
 * @param state - Client state
 * @param line - Raw JSON line from client
 */
async function processMessage(state: ClientState, line: string): Promise<void> {
    // -------------------------------------------------------------------------
    // Parse JSON
    // -------------------------------------------------------------------------
    let msg: SyscallRequest;

    try {
        msg = JSON.parse(line);
    }
    catch {
        await sendError(state, 'parse', 'EINVAL', 'Invalid JSON');

        return;
    }

    // -------------------------------------------------------------------------
    // Validate message type
    // -------------------------------------------------------------------------
    if (msg.type !== 'syscall') {
        await sendError(state, msg.id ?? 'unknown', 'EINVAL', `Unknown message type: ${msg.type}`);

        return;
    }

    // -------------------------------------------------------------------------
    // Check disconnect state
    // -------------------------------------------------------------------------
    // INVARIANT: Don't accept new requests if disconnecting
    if (state.disconnecting) {
        return;
    }

    // -------------------------------------------------------------------------
    // Concurrency limit check
    // -------------------------------------------------------------------------
    if (state.activeStreams.size >= MAX_CONCURRENT_STREAMS) {
        await sendError(state, msg.id, 'EAGAIN', `Too many concurrent requests (max ${MAX_CONCURRENT_STREAMS})`);

        return;
    }

    // -------------------------------------------------------------------------
    // Dispatch syscall (fire-and-forget)
    // -------------------------------------------------------------------------
    const { id, name, args } = msg;

    // WHY fire-and-forget: Allows concurrent requests from same client.
    // Each dispatchSyscall runs independently, responses are interleaved.
    // Errors are logged but don't crash the client handler.
    dispatchSyscall(state, id, name, args).catch(async err => {
        await eprintln(`gatewayd: ${state.clientId} dispatch error: ${err}`);
    });
}

// =============================================================================
// CLIENT HANDLING
// =============================================================================

/**
 * Handle a connected client.
 *
 * Main client loop: read from socket, parse messages, dispatch syscalls.
 *
 * ALGORITHM:
 * 1. Read chunks from socket until EOF
 * 2. Accumulate in buffer until newline
 * 3. Process complete lines as messages
 * 4. On EOF/error, cleanup and exit
 *
 * EDGE CASES:
 * - Partial JSON lines: Accumulated across read() calls
 * - Empty lines: Ignored (trimmed)
 * - Binary garbage: JSON parse fails, error sent, continue
 * - Oversized buffer: Disconnect client (DoS protection)
 *
 * @param state - Client state (created in accept loop)
 */
async function handleClient(state: ClientState): Promise<void> {
    const { socketFd, clientId } = state;

    try {
        while (true) {
            // -----------------------------------------------------------------
            // Read from socket
            // -----------------------------------------------------------------
            const chunk = await read(socketFd);

            if (chunk.length === 0) {
                // EOF - client closed connection gracefully
                break;
            }

            // -----------------------------------------------------------------
            // Accumulate in buffer
            // -----------------------------------------------------------------
            state.readBuffer += new TextDecoder().decode(chunk);

            // SAFETY: Check buffer size to prevent memory exhaustion
            if (state.readBuffer.length > MAX_READ_BUFFER_SIZE) {
                await eprintln(`gatewayd: ${clientId} read buffer overflow, disconnecting`);
                break;
            }

            // -----------------------------------------------------------------
            // Process complete messages (newline-delimited)
            // -----------------------------------------------------------------
            let newlineIdx: number;

            while ((newlineIdx = state.readBuffer.indexOf('\n')) !== -1) {
                const line = state.readBuffer.slice(0, newlineIdx);

                state.readBuffer = state.readBuffer.slice(newlineIdx + 1);

                // EDGE: Skip empty lines (just newlines or whitespace)
                if (line.trim()) {
                    await processMessage(state, line);
                }
            }
        }
    }
    finally {
        // INVARIANT: Mark disconnecting BEFORE cleanup
        // This signals active dispatch loops to exit
        state.disconnecting = true;

        await println(`gatewayd: ${clientId} disconnected`);
        await cleanupClient(state);
        clients.delete(socketFd);
    }
}

/**
 * Cleanup client state on disconnect.
 *
 * ALGORITHM:
 * 1. Cancel all active syscall streams
 * 2. Clear the active streams set
 * 3. Close the socket fd
 *
 * CONCURRENCY:
 * Active dispatch loops may still be running when this is called.
 * They check state.disconnecting and exit gracefully.
 * cancelStream() signals the kernel to stop sending responses.
 *
 * @param state - Client state to cleanup
 */
async function cleanupClient(state: ClientState): Promise<void> {
    // Cancel all active syscall streams
    // WHY: Frees kernel resources and stops response generation
    for (const streamId of state.activeStreams) {
        cancelStream(streamId);
    }

    state.activeStreams.clear();

    // Close socket
    // SAFETY: Catch errors - socket may already be closed
    try {
        await close(state.socketFd);
    }
    catch {
        // Ignore - socket may have errored or been closed by kernel
    }
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Main entry point for gatewayd.
 *
 * ALGORITHM:
 * 1. Remove existing socket file (if present)
 * 2. Listen on Unix socket
 * 3. Accept loop: create ClientState, spawn handleClient
 *
 * LIFECYCLE:
 * - Runs forever (until process killed)
 * - Each client handled in background (fire-and-forget)
 * - Errors in client handlers are logged, don't crash daemon
 *
 * RUNTIME BEHAVIOR:
 * The VFS loader auto-invokes the default export if it's a function.
 * No explicit main() call needed at the end of the file.
 */
async function main(): Promise<void> {
    await println(`gatewayd: starting on ${SOCKET_PATH}`);

    // -------------------------------------------------------------------------
    // Remove existing socket file
    // -------------------------------------------------------------------------
    // WHY: Unix sockets leave files behind. If we don't remove it,
    // listen() fails with EADDRINUSE.
    try {
        await unlink(SOCKET_PATH);
    }
    catch {
        // Socket file may not exist on first run - ignore
    }

    // -------------------------------------------------------------------------
    // Listen on Unix socket
    // -------------------------------------------------------------------------
    const portFd = await listen({
        port: 0,  // Ignored for Unix sockets
        unix: SOCKET_PATH,
    });

    await println(`gatewayd: listening on ${SOCKET_PATH}`);

    // -------------------------------------------------------------------------
    // Accept loop
    // -------------------------------------------------------------------------
    while (true) {
        try {
            // Wait for client connection
            const msg = await recv(portFd);
            const socketFd = msg.fd!;

            // Create client state
            const clientId = `client-${nextClientId++}`;
            const state: ClientState = {
                socketFd,
                readBuffer: '',
                clientId,
                activeStreams: new Set(),
                disconnecting: false,
            };

            clients.set(socketFd, state);
            await println(`gatewayd: ${clientId} connected`);

            // Handle client in background (fire-and-forget)
            // WHY: Don't block accept loop waiting for client to finish
            handleClient(state).catch(async err => {
                await eprintln(`gatewayd: ${clientId} error: ${err}`);
            });
        }
        catch (err) {
            // Accept error - log and continue
            // WHY: Individual accept failures shouldn't crash the daemon
            await eprintln(`gatewayd: accept error: ${err}`);
        }
    }
}

// Run gatewayd
main().catch(async err => {
    await eprintln(`gatewayd: fatal error: ${err}`);
});
