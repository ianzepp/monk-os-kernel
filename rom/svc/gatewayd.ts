/**
 * gatewayd - Unix Socket Gateway Daemon
 *
 * Bridges external applications to the OS kernel via Unix socket.
 * External apps connect to /tmp/monk.sock and send syscall messages.
 * gatewayd proxies these to the kernel and streams responses back.
 *
 * MENTAL MODEL
 * ============
 * gatewayd is a message pipeline, similar to `cat | cat | cat`:
 *
 *   Unix socket in → gatewayd → syscallStream() → Unix socket out
 *
 * All syscalls are treated as streams. Some yield one response (ok/error),
 * others yield many (item...item...done). gatewayd doesn't distinguish -
 * it forwards each Response as it arrives until a terminal op ends the stream.
 *
 * ARCHITECTURE
 * ============
 *   External app (os-sdk)
 *       ──► Unix socket ──► gatewayd (Worker)
 *                               ──► syscallStream() ──► Kernel
 *                               ◄── Response stream ◄──
 *       ◄── Unix socket ◄──
 *
 * WIRE FORMAT (newline-delimited JSON)
 * ====================================
 * Request:
 *   { type: 'syscall', id: string, name: string, args: unknown[] }
 *
 * Response (one per stream item):
 *   { type: 'response', id: string, result: { op, data?, bytes? } }
 *
 * Error (transport-level):
 *   { type: 'response', id: string, error: { code, message } }
 *
 * The `id` field correlates responses to requests, allowing concurrent
 * requests with interleaved responses.
 *
 * Response `op` values:
 *   - 'ok'       Terminal. Success with optional data.
 *   - 'error'    Terminal. Syscall failed.
 *   - 'done'     Terminal. Stream complete (after items).
 *   - 'redirect' Terminal. Follow redirect.
 *   - 'item'     Non-terminal. One item in a sequence.
 *   - 'data'     Non-terminal. Binary data chunk.
 *   - 'event'    Non-terminal. Async event notification.
 *   - 'progress' Non-terminal. Progress indicator.
 *
 * BACKPRESSURE
 * ============
 * Backpressure flows naturally end-to-end:
 *
 *   1. Client can't read from socket fast enough
 *   2. gatewayd's write() blocks
 *   3. gatewayd's for-await loop stalls
 *   4. syscallStream() stops yielding (no ping to kernel)
 *   5. Kernel pauses at HIGH_WATER mark
 *
 * No explicit backpressure handling needed - the async pipeline self-regulates.
 *
 * CONCURRENCY
 * ===========
 * Multiple requests from the same client run concurrently. Each dispatch is
 * fire-and-forget, allowing the read loop to process the next request while
 * previous streams are still active. JavaScript's async event loop interleaves
 * the for-await loops naturally.
 *
 * DISCONNECT HANDLING
 * ===================
 * When a client disconnects:
 *   1. Read loop exits (EOF or error)
 *   2. state.disconnecting = true (stops new requests)
 *   3. All active streams cancelled via cancelStream()
 *   4. Socket closed
 *
 * Active dispatch loops check state.disconnecting and exit gracefully.
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

import {
    listen,
    recv,
    read,
    write,
    close,
    println,
    eprintln,
} from '@rom/lib/process/index.js';
import { syscallStream, cancelStream } from '@rom/lib/process/syscall.js';
import type { Response } from '@rom/lib/process/types.js';

// Default socket path
const SOCKET_PATH = process.env.MONK_SOCKET ?? '/tmp/monk.sock';

/**
 * Per-connection client state.
 */
interface ClientState {
    /** Socket fd for this connection */
    socketFd: number;

    /** Read buffer for incomplete messages */
    readBuffer: string;

    /** Client identifier for logging */
    clientId: string;

    /** Active stream IDs for cancellation on disconnect */
    activeStreams: Set<string>;

    /** Whether client is disconnecting (stop accepting new requests) */
    disconnecting: boolean;
}

// Active clients
const clients = new Map<number, ClientState>();
let nextClientId = 1;

/**
 * Main entry point.
 */
async function main(): Promise<void> {
    await println(`gatewayd: starting on ${SOCKET_PATH}`);

    // Remove existing socket file if present
    try {
        const { unlink } = await import('@rom/lib/process/index.js');

        await unlink(SOCKET_PATH);
    }
    catch {
        // Socket file may not exist, ignore
    }

    // Listen on Unix socket
    const portFd = await listen({
        port: 0,
        unix: SOCKET_PATH,
    });

    await println(`gatewayd: listening on ${SOCKET_PATH}`);

    // Accept connections and handle them
    while (true) {
        try {
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

            // Handle client in background (don't await)
            handleClient(state).catch(async err => {
                await eprintln(`gatewayd: ${clientId} error: ${err}`);
            });
        }
        catch (err) {
            await eprintln(`gatewayd: accept error: ${err}`);
        }
    }
}

/**
 * Handle a connected client.
 *
 * Reads syscall messages from socket, dispatches to kernel, sends responses.
 */
async function handleClient(state: ClientState): Promise<void> {
    const { socketFd, clientId } = state;

    try {
        while (true) {
            // Read from socket
            const chunk = await read(socketFd);

            if (chunk.length === 0) {
                // EOF - client disconnected
                break;
            }

            // Append to buffer and process complete messages
            state.readBuffer += new TextDecoder().decode(chunk);

            // Messages are newline-delimited JSON
            let newlineIdx: number;

            while ((newlineIdx = state.readBuffer.indexOf('\n')) !== -1) {
                const line = state.readBuffer.slice(0, newlineIdx);

                state.readBuffer = state.readBuffer.slice(newlineIdx + 1);

                if (line.trim()) {
                    await processMessage(state, line);
                }
            }
        }
    }
    finally {
        // Mark as disconnecting to stop new requests
        state.disconnecting = true;

        // Cleanup
        await println(`gatewayd: ${clientId} disconnected`);
        await cleanupClient(state);
        clients.delete(socketFd);
    }
}

/**
 * Process a single syscall message from client.
 *
 * Dispatches syscall and streams responses back. Fire-and-forget
 * to allow concurrent requests from the same client.
 */
async function processMessage(state: ClientState, line: string): Promise<void> {
    let msg: { type: string; id: string; name: string; args: unknown[] };

    try {
        msg = JSON.parse(line);
    }
    catch {
        await sendError(state, 'parse', 'EINVAL', 'Invalid JSON');

        return;
    }

    if (msg.type !== 'syscall') {
        await sendError(state, msg.id ?? 'unknown', 'EINVAL', `Unknown message type: ${msg.type}`);

        return;
    }

    // Don't accept new requests if disconnecting
    if (state.disconnecting) {
        return;
    }

    const { id, name, args } = msg;

    // Fire-and-forget: dispatch in background to allow concurrent requests
    dispatchSyscall(state, id, name, args).catch(async err => {
        await eprintln(`gatewayd: ${state.clientId} syscall error: ${err}`);
    });
}

/**
 * Dispatch a syscall on behalf of the client.
 *
 * Streams all responses back to the client. All syscalls are treated
 * as streams - some yield one response (ok/error), others yield many
 * (item...item...done).
 *
 * All clients share gatewayd's process context until virtual
 * process support is added to the kernel.
 */
async function dispatchSyscall(
    state: ClientState,
    id: string,
    name: string,
    args: unknown[],
): Promise<void> {
    // Track this stream for cancellation on disconnect
    state.activeStreams.add(id);

    try {
        for await (const response of syscallStream(name, ...args)) {
            // Stop if client disconnected
            if (state.disconnecting) {
                cancelStream(id);
                break;
            }

            // Forward response to client
            await sendResponse(state, id, response);

            // Terminal ops end the stream
            if (response.op === 'ok' || response.op === 'error' ||
                response.op === 'done' || response.op === 'redirect') {
                break;
            }
        }
    }
    catch (err: unknown) {
        // Send error response if stream throws
        const error = err as Error & { code?: string };

        await sendError(state, id, error.code ?? 'EIO', error.message);
    }
    finally {
        state.activeStreams.delete(id);
    }
}

/**
 * Send a response to client.
 *
 * Forwards the Response object as-is, preserving the op field
 * so clients can distinguish item/data/event/ok/error/done.
 */
async function sendResponse(state: ClientState, id: string, result: Response): Promise<void> {
    const message = JSON.stringify({
        type: 'response',
        id,
        result,
    }) + '\n';

    await write(state.socketFd, new TextEncoder().encode(message));
}

/**
 * Send an error response to client.
 */
async function sendError(state: ClientState, id: string, code: string, message: string): Promise<void> {
    const response = JSON.stringify({
        type: 'response',
        id,
        error: { code, message },
    }) + '\n';

    await write(state.socketFd, new TextEncoder().encode(response));
}

/**
 * Cleanup client state on disconnect.
 *
 * Cancels all active streams and closes the socket.
 *
 * TODO: When virtual processes are implemented, this should
 * terminate the client's virtual process to cleanup handles.
 */
async function cleanupClient(state: ClientState): Promise<void> {
    // Cancel all active streams
    for (const streamId of state.activeStreams) {
        cancelStream(streamId);
    }

    state.activeStreams.clear();

    // Close socket
    try {
        await close(state.socketFd);
    }
    catch {
        // Ignore
    }
}

// Run gatewayd
main().catch(async err => {
    await eprintln(`gatewayd: fatal error: ${err}`);
});
