/**
 * gatewayd - Unix Socket Gateway Daemon
 *
 * Bridges external applications to the OS kernel via Unix socket.
 * External apps connect to /tmp/monk.sock and send syscall messages.
 * gatewayd proxies these to the kernel and streams responses back.
 *
 * ARCHITECTURE
 * ============
 * External app (os-sdk)
 *     → Unix socket → gatewayd (Worker)
 *         → postMessage → Kernel
 *             → syscall execution
 *         ← postMessage ← Kernel
 *     ← Unix socket ← gatewayd
 * ← result ←
 *
 * MESSAGE FORMAT (JSON over Unix socket)
 * ======================================
 * Request:  { type: 'syscall', id: string, name: string, args: unknown[] }
 * Response: { type: 'response', id: string, result?: unknown, error?: { code, message } }
 *
 * The message format matches the kernel's internal SyscallRequest/SyscallResponse.
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
 */

import {
    listen,
    recv,
    read,
    write,
    pclose,
    println,
    eprintln,
} from '@src/process/index.js';
import { syscall } from '@src/process/syscall.js';

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
        const { unlink } = await import('@src/process/index.js');
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
        // Cleanup
        await println(`gatewayd: ${clientId} disconnected`);
        await cleanupClient(state);
        clients.delete(socketFd);
    }
}

/**
 * Process a single syscall message from client.
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

    const { id, name, args } = msg;

    try {
        // Dispatch syscall
        const result = await dispatchSyscall(name, args);

        // Send success response
        await sendResponse(state, id, result);
    }
    catch (err: unknown) {
        // Send error response
        const error = err as Error & { code?: string };
        await sendError(state, id, error.code ?? 'EIO', error.message);
    }
}

/**
 * Dispatch a syscall on behalf of the client.
 *
 * Simple passthrough - forwards syscall directly to kernel.
 * All clients share gatewayd's process context until virtual
 * process support is added to the kernel.
 */
async function dispatchSyscall(name: string, args: unknown[]): Promise<unknown> {
    return await syscall(name, ...args);
}

/**
 * Send a success response to client.
 */
async function sendResponse(state: ClientState, id: string, result: unknown): Promise<void> {
    const response = JSON.stringify({
        type: 'response',
        id,
        result,
    }) + '\n';

    await write(state.socketFd, new TextEncoder().encode(response));
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
 * TODO: When virtual processes are implemented, this should
 * terminate the client's virtual process to cleanup handles.
 */
async function cleanupClient(state: ClientState): Promise<void> {
    // Close socket
    try {
        await pclose(state.socketFd);
    }
    catch {
        // Ignore
    }
}

// Run gatewayd
main().catch(async err => {
    await eprintln(`gatewayd: fatal error: ${err}`);
});
