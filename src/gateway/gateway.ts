/**
 * Gateway - External syscall interface over Unix socket
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Gateway provides external applications (os-shell, displayd) access to
 * Monk OS syscalls over a Unix domain socket. Each client connection gets an
 * isolated virtual process with its own handle table, cwd, and environment.
 *
 * This runs in kernel context (not as a Worker), so syscalls execute directly
 * via dispatcher.execute() without postMessage IPC overhead.
 *
 * WIRE PROTOCOL (newline-delimited JSON)
 * ======================================
 *
 * Request (client -> gateway):
 *   { "id": "<client-id>", "call": "<syscall>", "args": [...] }
 *
 * Response (gateway -> client), one per stream item:
 *   { "id": "<client-id>", "op": "ok", "data": {...} }
 *   { "id": "<client-id>", "op": "error", "code": "ENOENT", "message": "..." }
 *   { "id": "<client-id>", "op": "item", "data": {...} }
 *   { "id": "<client-id>", "op": "data", "bytes": "<base64>" }
 *   { "id": "<client-id>", "op": "done" }
 *
 * The "id" field is client-generated and echoed back for correlation,
 * enabling concurrent requests with interleaved responses.
 *
 * Response "op" values:
 *   - ok       Terminal success with optional data
 *   - error    Terminal failure with code and message
 *   - done     Terminal stream completion (after items)
 *   - redirect Terminal redirect (symlinks, mounts)
 *   - item     Non-terminal stream item
 *   - data     Non-terminal binary chunk (base64)
 *   - event    Non-terminal async notification
 *   - progress Non-terminal progress indicator
 *
 * CONCURRENCY MODEL
 * =================
 * - Multiple clients connect concurrently (each gets a virtual process)
 * - Each client can have multiple concurrent requests (fire-and-forget dispatch)
 * - JavaScript event loop interleaves async operations naturally
 *
 * INVARIANTS
 * ==========
 * INV-1: Each client connection has exactly one virtual process
 * INV-2: Virtual process is destroyed when client disconnects
 * INV-3: All active streams are cancelled on client disconnect
 *
 * @module gateway
 */

import { unlink } from 'node:fs/promises';
import type { Kernel } from '@src/kernel/kernel.js';
import type { HAL } from '@src/hal/index.js';
import type { Listener, Socket } from '@src/hal/network.js';
import type { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import type { Process, Response } from '@src/syscall/types.js';
import { createVirtualProcess } from '@src/kernel/kernel/create-virtual-process.js';
import { forceExit } from '@src/kernel/kernel/force-exit.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum read buffer size per client (1MB).
 * WHY: Prevent memory exhaustion from malformed input.
 */
const MAX_READ_BUFFER_SIZE = 1024 * 1024;

// =============================================================================
// GATEWAY CLASS
// =============================================================================

/**
 * Unix socket gateway for external syscall access.
 *
 * Provides external applications (os-shell, displayd) with syscall access.
 * Each client connection gets an isolated virtual process.
 */
export class Gateway {
    /** Unix socket listener */
    private listener?: Listener;

    /** Client counter for logging */
    private nextClientId = 1;

    /** Active clients for cleanup on stop */
    private clients = new Set<Socket>();

    constructor(
        private readonly dispatcher: SyscallDispatcher,
        private readonly kernel: Kernel,
        private readonly hal: HAL,
    ) {}

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Start listening for external connections.
     *
     * @param socketPath - Unix socket path (e.g., /tmp/monk.sock)
     */
    async listen(socketPath: string): Promise<void> {
        // Remove stale socket file
        // WHY: Unix sockets leave files behind. If we don't remove it,
        // listen() fails with EADDRINUSE.
        try {
            await unlink(socketPath);
        }
        catch {
            // May not exist on first run
        }

        // Create listener
        this.listener = await this.hal.network.listen(0, { unix: socketPath });

        // Accept loop (fire-and-forget)
        this.acceptLoop();
    }

    /**
     * Stop the gateway and disconnect all clients.
     */
    async stop(): Promise<void> {
        // Close listener first to prevent new connections
        if (this.listener) {
            await this.listener.close();
            this.listener = undefined;
        }

        // Close all client sockets
        for (const socket of this.clients) {
            try {
                await socket.close();
            }
            catch {
                // May already be closed
            }
        }

        this.clients.clear();
    }

    // =========================================================================
    // ACCEPT LOOP
    // =========================================================================

    /**
     * Accept loop - handles incoming connections.
     */
    private async acceptLoop(): Promise<void> {
        if (!this.listener) return;

        try {
            while (this.listener) {
                const socket = await this.listener.accept();
                this.clients.add(socket);

                // Handle client (fire-and-forget)
                this.handleClient(socket).finally(() => {
                    this.clients.delete(socket);
                });
            }
        }
        catch {
            // Listener closed - normal during shutdown
        }
    }

    // =========================================================================
    // CLIENT HANDLING
    // =========================================================================

    /**
     * Handle a connected client.
     *
     * Creates a virtual process for isolation, then reads JSON lines and
     * dispatches syscalls.
     *
     * @param socket - Client socket
     */
    private async handleClient(socket: Socket): Promise<void> {
        const clientId = `gateway-${this.nextClientId++}`;

        // Get init process as parent for virtual processes
        const init = this.kernel.processes.getInit();

        if (!init) {
            // Kernel not booted - reject connection
            await socket.close();
            return;
        }

        // Create virtual process for this connection
        const { id: procId } = createVirtualProcess(this.kernel, init, {
            cwd: '/',
            env: { ...init.env },
        });

        const proc = this.kernel.processes.get(procId);

        if (!proc) {
            await socket.close();
            return;
        }

        let readBuffer = '';
        let disconnecting = false;

        try {
            // Read loop
            while (!disconnecting) {
                const chunk = await socket.read();

                // EOF - client disconnected
                if (chunk.length === 0) {
                    break;
                }

                readBuffer += new TextDecoder().decode(chunk);

                // Buffer overflow protection
                if (readBuffer.length > MAX_READ_BUFFER_SIZE) {
                    break;
                }

                // Process complete lines
                let newlineIdx: number;

                while ((newlineIdx = readBuffer.indexOf('\n')) !== -1) {
                    const line = readBuffer.slice(0, newlineIdx);
                    readBuffer = readBuffer.slice(newlineIdx + 1);

                    if (line.trim()) {
                        // Fire-and-forget dispatch
                        this.processMessage(socket, proc, line, () => disconnecting).catch(() => {
                            // Ignore dispatch errors
                        });
                    }
                }
            }
        }
        finally {
            disconnecting = true;

            // Cancel active streams
            for (const abort of proc.activeStreams.values()) {
                abort.abort();
            }

            proc.activeStreams.clear();
            proc.streamPingHandlers.clear();

            // Destroy virtual process
            forceExit(this.kernel, proc, 0);

            // Close socket
            try {
                await socket.close();
            }
            catch {
                // May already be closed
            }
        }
    }

    // =========================================================================
    // MESSAGE PROCESSING
    // =========================================================================

    /**
     * Process a single JSON message from client.
     *
     * @param socket - Client socket
     * @param proc - Virtual process for this client
     * @param line - Raw JSON line
     * @param isDisconnecting - Function to check disconnect state
     */
    private async processMessage(
        socket: Socket,
        proc: Process,
        line: string,
        isDisconnecting: () => boolean,
    ): Promise<void> {
        // Parse JSON
        let msg: { id?: string; call?: string; args?: unknown[] };

        try {
            msg = JSON.parse(line);
        }
        catch {
            await this.sendError(socket, 'parse', 'EINVAL', 'Invalid JSON');
            return;
        }

        const id = msg.id ?? 'unknown';

        // Validate required fields
        if (!msg.call) {
            await this.sendError(socket, id, 'EINVAL', 'Missing "call" field');
            return;
        }

        // Check disconnect state
        if (isDisconnecting()) return;

        // Dispatch syscall and stream responses
        try {
            for await (const response of this.dispatcher.execute(proc, id, msg.call, msg.args ?? [])) {
                if (isDisconnecting()) break;

                const sent = await this.sendResponse(socket, id, response);

                if (!sent) break;

                // Terminal ops end stream
                if (response.op === 'ok' || response.op === 'error' ||
                    response.op === 'done' || response.op === 'redirect') {
                    break;
                }
            }
        }
        catch (err) {
            const error = err as Error & { code?: string };

            if (!isDisconnecting()) {
                await this.sendError(socket, id, error.code ?? 'EIO', error.message);
            }
        }
    }

    // =========================================================================
    // RESPONSE HELPERS
    // =========================================================================

    /**
     * Send a syscall response to client.
     *
     * Flattens the kernel Response into wire format:
     *   { id, op, ...rest }
     *
     * @returns true if sent, false if socket dead
     */
    private async sendResponse(socket: Socket, id: string, response: Response): Promise<boolean> {
        const wireResponse = this.prepareForWire(id, response);
        const message = JSON.stringify(wireResponse) + '\n';

        return this.safeWrite(socket, message);
    }

    /**
     * Send an error response to client.
     *
     * Uses unified error format: { id, op: "error", code, message }
     *
     * @returns true if sent, false if socket dead
     */
    private async sendError(socket: Socket, id: string, code: string, message: string): Promise<boolean> {
        const response = JSON.stringify({
            id,
            op: 'error',
            code,
            message,
        }) + '\n';

        return this.safeWrite(socket, response);
    }

    /**
     * Safely write to socket, handling errors.
     *
     * @returns true if write succeeded, false otherwise
     */
    private async safeWrite(socket: Socket, data: string): Promise<boolean> {
        try {
            await socket.write(new TextEncoder().encode(data));
            return true;
        }
        catch {
            return false;
        }
    }

    /**
     * Prepare response for JSON wire format.
     *
     * Flattens kernel Response into: { id, op, ...fields }
     * Converts Uint8Array to base64 for transport.
     */
    private prepareForWire(id: string, response: Response): object {
        // Start with id and op
        const wire: Record<string, unknown> = { id, op: response.op };

        // Copy data fields (if present)
        if ('data' in response && response.data !== undefined) {
            // Flatten data into top level for cleaner wire format
            // e.g., { op: "ok", data: { fd: 3 } } -> { id, op: "ok", data: { fd: 3 } }
            wire.data = response.data;
        }

        // Handle binary data (base64 encode)
        if ('bytes' in response && (response as any).bytes instanceof Uint8Array) {
            const bytes = (response as any).bytes as Uint8Array;
            let binary = '';

            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]!);
            }

            wire.bytes = btoa(binary);
        }

        // Copy error fields for op: "error" responses from kernel
        if (response.op === 'error' && 'data' in response) {
            const errorData = response.data as { code?: string; message?: string };

            if (errorData.code) wire.code = errorData.code;
            if (errorData.message) wire.message = errorData.message;

            // Remove nested data since we flattened code/message
            delete wire.data;
        }

        return wire;
    }
}
