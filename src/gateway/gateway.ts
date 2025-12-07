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
 * WIRE PROTOCOL (length-prefixed MessagePack)
 * ===========================================
 *
 * Each message is framed as:
 *   [4-byte big-endian length][msgpack payload]
 *
 * Request (client -> gateway):
 *   { id: "<client-id>", call: "<syscall>", args: [...] }
 *
 * Response (gateway -> client), one per stream item:
 *   { id: "<client-id>", op: "ok", data: {...} }
 *   { id: "<client-id>", op: "error", code: "ENOENT", message: "..." }
 *   { id: "<client-id>", op: "item", data: {...} }
 *   { id: "<client-id>", op: "data", bytes: Uint8Array }
 *   { id: "<client-id>", op: "done" }
 *
 * Binary data (Uint8Array) is serialized natively by MessagePack.
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
 *   - data     Non-terminal binary chunk
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
import { pack, unpack } from 'msgpackr';
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
     * Creates a virtual process for isolation, then reads length-prefixed
     * msgpack messages and dispatches syscalls.
     *
     * ALGORITHM:
     * 1. Create virtual process for isolation
     * 2. Read loop: accumulate chunks, extract complete messages
     * 3. For each message: fire-and-forget dispatch to processMessage
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

        // Binary buffer for length-prefixed framing
        let readBuffer = new Uint8Array(0);
        let disconnecting = false;

        try {
            // Read loop
            while (!disconnecting) {
                const chunk = await socket.read();

                // EOF - client disconnected
                if (chunk.length === 0) {
                    break;
                }

                // Append chunk to buffer
                const newBuffer = new Uint8Array(readBuffer.length + chunk.length);

                newBuffer.set(readBuffer);
                newBuffer.set(chunk, readBuffer.length);
                readBuffer = newBuffer;

                // Buffer overflow protection - send error before disconnecting
                if (readBuffer.length > MAX_READ_BUFFER_SIZE) {
                    await this.sendError(socket, 'overflow', 'ENOMEM', 'Read buffer overflow');
                    break;
                }

                // Process complete messages (4-byte length prefix + payload)
                while (readBuffer.length >= 4) {
                    const view = new DataView(readBuffer.buffer, readBuffer.byteOffset);
                    const msgLength = view.getUint32(0);

                    // Wait for complete message
                    if (readBuffer.length < 4 + msgLength) {
                        break;
                    }

                    // Extract message payload
                    const payload = readBuffer.slice(4, 4 + msgLength);

                    readBuffer = readBuffer.slice(4 + msgLength);

                    // Fire-and-forget dispatch
                    this.processMessage(socket, proc, payload, () => disconnecting).catch(() => {
                        // Dispatch errors handled inside processMessage
                    });
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
     * Process a single msgpack message from client.
     *
     * @param socket - Client socket
     * @param proc - Virtual process for this client
     * @param payload - Raw msgpack payload
     * @param isDisconnecting - Function to check disconnect state
     */
    private async processMessage(
        socket: Socket,
        proc: Process,
        payload: Uint8Array,
        isDisconnecting: () => boolean,
    ): Promise<void> {
        // Decode msgpack
        let msg: { id?: string; call?: string; args?: unknown[] };

        try {
            msg = unpack(payload);
        }
        catch {
            await this.sendError(socket, 'parse', 'EINVAL', 'Invalid msgpack');

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

        // Args are passed directly - msgpack preserves Uint8Array natively
        const args = msg.args ?? [];

        // Dispatch syscall and stream responses
        try {
            for await (const response of this.dispatcher.execute(proc, id, msg.call, args)) {
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

        return this.sendFrame(socket, wireResponse);
    }

    /**
     * Send an error response to client.
     *
     * Uses unified error format: { id, op: "error", code, message }
     *
     * @returns true if sent, false if socket dead
     */
    private async sendError(socket: Socket, id: string, code: string, message: string): Promise<boolean> {
        return this.sendFrame(socket, { id, op: 'error', code, message });
    }

    /**
     * Send a length-prefixed msgpack frame to socket.
     *
     * @returns true if write succeeded, false otherwise
     */
    private async sendFrame(socket: Socket, data: unknown): Promise<boolean> {
        try {
            const payload = pack(data);
            const frame = new Uint8Array(4 + payload.length);
            const view = new DataView(frame.buffer);

            view.setUint32(0, payload.length);
            frame.set(payload, 4);

            await socket.write(frame);

            return true;
        }
        catch {
            return false;
        }
    }

    // =========================================================================
    // RESPONSE PREPARATION
    // =========================================================================

    /**
     * Prepare response for msgpack wire format.
     *
     * Flattens kernel Response into: { id, op, ...fields }
     * Uint8Array passes through directly (msgpack handles binary natively).
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

        // Pass binary data directly (msgpack handles Uint8Array natively)
        if ('bytes' in response) {
            const bytes = (response as { bytes?: unknown }).bytes;

            if (bytes instanceof Uint8Array) {
                wire.bytes = bytes;
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
