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
 *        VIOLATED BY: createVirtualProcess failure (handled by early return)
 * INV-2: Virtual process is destroyed when client disconnects
 *        ENFORCED BY: finally block in handleClient()
 * INV-3: All active streams are cancelled on client disconnect
 *        ENFORCED BY: finally block in handleClient()
 * INV-4: readBuffer never exceeds MAX_READ_BUFFER_SIZE
 *        ENFORCED BY: check in read loop, sends error before disconnect
 * INV-5: Response "id" always matches request "id"
 *        ENFORCED BY: id passed through all send methods
 * INV-6: Terminal ops (ok, error, done, redirect) end response stream
 *        ENFORCED BY: break after terminal op in processMessage()
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: shutdown() copies client Set before iteration to avoid mutation during iteration
 * RC-2: acceptLoop() stores listener reference to avoid null check after await
 * RC-3: isDisconnecting closure checked after every await in processMessage()
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
// TYPES
// =============================================================================

/**
 * Injectable dependencies for testing.
 *
 * TESTABILITY: Allows tests to mock filesystem operations and verify behavior
 * without actual Unix socket creation.
 */
export interface GatewayDeps {
    /** Remove socket file before listening (default: fs.unlink) */
    unlink: (path: string) => Promise<void>;
}

/**
 * Create default production dependencies.
 */
function createDefaultDeps(): GatewayDeps {
    return {
        unlink: (path: string) => unlink(path).catch(() => {}),
    };
}

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
    // =========================================================================
    // CORE DEPENDENCIES
    // =========================================================================

    /** Injectable dependencies for testing */
    private readonly deps: GatewayDeps;

    // =========================================================================
    // STATE
    // =========================================================================

    /** Unix socket listener */
    private listener?: Listener;

    /** Client counter for unique IDs */
    private nextClientId = 1;

    /** Active clients for cleanup on shutdown */
    private clients = new Set<Socket>();

    /**
     * Shutdown flag to distinguish clean shutdown from errors.
     * WHY: acceptLoop() catch block needs to know if error is expected.
     */
    private shuttingDown = false;

    // =========================================================================
    // SHARED ENCODERS
    // =========================================================================

    /**
     * Shared TextEncoder instance.
     * WHY: Avoid creating new encoder for every write operation.
     */
    private readonly textEncoder = new TextEncoder();

    constructor(
        private readonly dispatcher: SyscallDispatcher,
        private readonly kernel: Kernel,
        private readonly hal: HAL,
        deps?: Partial<GatewayDeps>,
    ) {
        this.deps = { ...createDefaultDeps(), ...deps };
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get count of connected clients.
     * TESTING: Allows tests to verify connection tracking.
     */
    getClientCount(): number {
        return this.clients.size;
    }

    /**
     * Check if gateway is listening.
     * TESTING: Allows tests to verify lifecycle state.
     */
    isListening(): boolean {
        return this.listener !== undefined;
    }

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
        await this.deps.unlink(socketPath);

        // Reset shutdown flag in case gateway is being restarted
        this.shuttingDown = false;

        // Create listener
        this.listener = await this.hal.network.listen(0, { unix: socketPath });

        // Accept loop (fire-and-forget)
        this.acceptLoop();
    }

    /**
     * Shutdown the gateway and disconnect all clients.
     *
     * ALGORITHM:
     * 1. Set shuttingDown flag (so acceptLoop knows this is intentional)
     * 2. Close listener (stops new connections, causes accept() to throw)
     * 3. Close all client sockets (copy Set first to avoid mutation during iteration)
     */
    async shutdown(): Promise<void> {
        // Set flag first so acceptLoop catch block knows this is intentional
        this.shuttingDown = true;

        // Close listener to prevent new connections
        if (this.listener) {
            await this.listener.close();
            this.listener = undefined;
        }

        // RC-1 FIX: Copy Set before iteration to avoid mutation during iteration.
        // handleClient().finally() deletes from this.clients, which would corrupt
        // iteration if we iterated directly.
        const clientsCopy = [...this.clients];

        for (const socket of clientsCopy) {
            try {
                await socket.close();
            }
            catch {
                // May already be closed by handleClient
            }
        }

        this.clients.clear();
    }

    // =========================================================================
    // ACCEPT LOOP
    // =========================================================================

    /**
     * Accept loop - handles incoming connections.
     *
     * RC-2 FIX: Store listener reference before loop to avoid checking
     * this.listener after await (it could be set to undefined by shutdown()).
     */
    private async acceptLoop(): Promise<void> {
        // RC-2: Capture reference before entering loop
        const listener = this.listener;

        if (!listener) {
            return;
        }

        try {
            // Loop until listener.accept() throws (closed by shutdown)
            while (true) {
                const socket = await listener.accept();

                this.clients.add(socket);

                // Handle client (fire-and-forget)
                this.handleClient(socket).finally(() => {
                    this.clients.delete(socket);
                });
            }
        }
        catch (err) {
            // Only log if this wasn't a clean shutdown
            if (!this.shuttingDown) {
                const error = err as Error;

                console.error(`Gateway accept error: ${error.message}`);
            }
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
     * ALGORITHM:
     * 1. Create virtual process for isolation
     * 2. Read loop: accumulate chunks, extract complete lines
     * 3. For each line: fire-and-forget dispatch to processMessage
     * 4. On disconnect: cancel streams, destroy process, close socket
     *
     * @param socket - Client socket
     */
    private async handleClient(socket: Socket): Promise<void> {
        // Generate unique client ID (used for debugging/logging)
        this.nextClientId++;

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

        // Create TextDecoder once per client (not per chunk)
        const textDecoder = new TextDecoder();

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

                readBuffer += textDecoder.decode(chunk, { stream: true });

                // Buffer overflow protection - send error before disconnecting
                if (readBuffer.length > MAX_READ_BUFFER_SIZE) {
                    await this.sendError(socket, 'overflow', 'ENOMEM', 'Read buffer overflow');
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
                            // Dispatch errors handled inside processMessage
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

            // Destroy virtual process (INV-2)
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
        if (isDisconnecting()) {
            return;
        }

        // Dispatch syscall and stream responses
        try {
            for await (const response of this.dispatcher.execute(proc, id, msg.call, msg.args ?? [])) {
                if (isDisconnecting()) {
                    break;
                }

                const sent = await this.sendResponse(socket, id, response);

                if (!sent) {
                    break;
                }

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
            await socket.write(this.textEncoder.encode(data));

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
        // PERF: Use Buffer.toString('base64') instead of string concat loop (O(n) vs O(n²))
        if ('bytes' in response) {
            const bytes = (response as { bytes?: unknown }).bytes;

            if (bytes instanceof Uint8Array) {
                wire.bytes = Buffer.from(bytes).toString('base64');
            }
        }

        // Copy error fields for op: "error" responses from kernel
        if (response.op === 'error' && 'data' in response) {
            const errorData = response.data as { code?: string; message?: string };

            if (errorData.code) {
                wire.code = errorData.code;
            }

            if (errorData.message) {
                wire.message = errorData.message;
            }

            // Remove nested data since we flattened code/message
            delete wire.data;
        }

        return wire;
    }
}
