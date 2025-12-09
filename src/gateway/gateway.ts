/**
 * Gateway - External syscall interface over TCP and WebSocket
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Gateway provides external applications (os-shell, browsers, displayd) access to
 * Monk OS syscalls over TCP and WebSocket. Each client connection gets an isolated
 * virtual process with its own handle table, cwd, and environment.
 *
 * This runs in kernel context (not as a Worker), so syscalls execute directly
 * via dispatcher.execute() without postMessage IPC overhead.
 *
 * DUAL TRANSPORT MODEL
 * ====================
 * Gateway listens on two ports:
 *
 * | Port | Transport | Framing                         | Clients           |
 * |------|-----------|---------------------------------|-------------------|
 * | 7778 | TCP       | 4-byte length prefix + msgpack  | os-sdk, os-shell  |
 * | 7779 | WebSocket | msgpack per WS binary frame     | browsers          |
 *
 * Both transports use identical msgpack message format. The only difference is framing:
 * - TCP: [4-byte length][msgpack]
 * - WebSocket: [msgpack] (WS handles framing natively)
 *
 * WIRE PROTOCOL (MessagePack)
 * ===========================
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
 * - TCP and WebSocket accept loops run concurrently
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Each client connection has exactly one virtual process
 *        VIOLATED BY: createVirtualProcess failure (handled by early return)
 * INV-2: Virtual process is destroyed when client disconnects
 *        ENFORCED BY: finally block in handleTcpClient() and handleWebSocketClient()
 * INV-3: All active streams are cancelled on client disconnect
 *        ENFORCED BY: finally block in client handlers
 * INV-4: TCP readBuffer never exceeds MAX_READ_BUFFER_SIZE
 *        ENFORCED BY: check in TCP read loop, sends error before disconnect
 * INV-5: Response "id" always matches request "id"
 *        ENFORCED BY: id passed through all send methods
 * INV-6: Terminal ops (ok, error, done, redirect) end response stream
 *        ENFORCED BY: break after terminal op in processMessage()
 * INV-7: shutdown() closes both TCP and WebSocket listeners and all clients
 *        ENFORCED BY: shutdown() iterates all client sets
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: shutdown() copies client Sets before iteration to avoid mutation during iteration
 * RC-2: acceptLoop() stores listener reference to avoid null check after await
 * RC-3: isDisconnecting closure checked after every await in processMessage()
 * RC-4: WebSocket message queue prevents lost messages during iteration
 *
 * MEMORY MANAGEMENT
 * =================
 * - Each client connection tracked in tcpClients or wsClients Set
 * - Virtual process cleaned up in finally blocks
 * - TCP read buffer cleared on disconnect
 * - WebSocket message queue cleared by connection wrapper
 *
 * @module gateway
 */

import { pack, unpack } from 'msgpackr';
import type { Kernel } from '@src/kernel/kernel.js';
import type { HAL } from '@src/hal/index.js';
import type { Listener, Socket, WebSocketServer, WebSocketConnection } from '@src/hal/network.js';
import type { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import type { Process, Response } from '@src/syscall/types.js';
import { createVirtualProcess } from '@src/kernel/kernel/create-virtual-process.js';
import { forceExit } from '@src/kernel/kernel/force-exit.js';
import { debug, debugDecode } from './debug.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum read buffer size per TCP client (1MB).
 * WHY: Prevent memory exhaustion from malformed input.
 * WebSocket has matching limit via maxPayloadLength.
 */
const MAX_READ_BUFFER_SIZE = 1024 * 1024;

/**
 * Default TCP port for the Gateway.
 * WHY: Standard port for server-side clients (os-sdk, os-shell).
 */
export const DEFAULT_GATEWAY_PORT = 7778;

/**
 * Default WebSocket port for the Gateway.
 * WHY: Separate port for browser clients. Keeps transport selection explicit.
 */
export const DEFAULT_WEBSOCKET_PORT = 7779;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Send function type for transport-agnostic response delivery.
 *
 * WHY: Abstracts the difference between TCP (length-prefixed) and WebSocket
 * (native binary frames) so processMessage() can be shared.
 *
 * TESTABILITY: Can be mocked to test processMessage() without real sockets.
 *
 * @param id - Request ID for response correlation
 * @param response - Kernel response to send
 * @returns true if sent successfully, false if transport dead
 */
type SendFn = (id: string, response: Response) => Promise<boolean>;

/**
 * Error send function type for transport-agnostic error delivery.
 *
 * WHY: Allows processMessage() to send parse errors without knowing transport.
 */
type SendErrorFn = (id: string, code: string, message: string) => Promise<boolean>;

// =============================================================================
// GATEWAY CLASS
// =============================================================================

/**
 * Dual-transport gateway for external syscall access.
 *
 * Provides external applications (os-shell, browsers, displayd) with syscall access.
 * Each client connection gets an isolated virtual process.
 *
 * Supports both TCP (for server-side clients) and WebSocket (for browsers).
 */
export class Gateway {
    // =========================================================================
    // STATE - TCP
    // =========================================================================

    /**
     * TCP listener for server-side clients.
     * WHY: os-sdk and os-shell connect via TCP with length-prefixed msgpack.
     */
    private tcpListener?: Listener;

    /**
     * Bound TCP port (set after listen).
     * WHY: Needed for getPort() when using port 0 (auto-assign).
     */
    private tcpPort?: number;

    /**
     * Active TCP clients for cleanup on shutdown.
     * WHY: Need to close all sockets on shutdown.
     */
    private tcpClients = new Set<Socket>();

    // =========================================================================
    // STATE - WEBSOCKET
    // =========================================================================

    /**
     * WebSocket server for browser clients.
     * WHY: Browsers cannot open raw TCP sockets, need WebSocket.
     */
    private wsServer?: WebSocketServer;

    /**
     * Bound WebSocket port (set after listen).
     * WHY: Needed for getWebSocketPort() when using port 0 (auto-assign).
     */
    private wsPort?: number;

    /**
     * Active WebSocket clients for cleanup on shutdown.
     * WHY: Need to close all connections on shutdown.
     */
    private wsClients = new Set<WebSocketConnection>();

    // =========================================================================
    // STATE - SHARED
    // =========================================================================

    /**
     * Client counter for unique IDs.
     * WHY: Used for debugging/logging to identify clients.
     */
    private nextClientId = 1;

    /**
     * Shutdown flag to distinguish clean shutdown from errors.
     * WHY: acceptLoop() catch blocks need to know if error is expected.
     */
    private shuttingDown = false;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    constructor(
        private readonly dispatcher: SyscallDispatcher,
        private readonly kernel: Kernel,
        private readonly hal: HAL,
    ) {}

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get count of connected TCP clients.
     * TESTING: Allows tests to verify TCP connection tracking.
     */
    getTcpClientCount(): number {
        return this.tcpClients.size;
    }

    /**
     * Get count of connected WebSocket clients.
     * TESTING: Allows tests to verify WebSocket connection tracking.
     */
    getWebSocketClientCount(): number {
        return this.wsClients.size;
    }

    /**
     * Get total count of connected clients (TCP + WebSocket).
     * TESTING: Backwards-compatible with existing tests.
     */
    getClientCount(): number {
        return this.tcpClients.size + this.wsClients.size;
    }

    /**
     * Check if gateway is listening on TCP.
     * TESTING: Allows tests to verify TCP lifecycle state.
     */
    isListening(): boolean {
        return this.tcpListener !== undefined;
    }

    /**
     * Check if gateway is listening on WebSocket.
     * TESTING: Allows tests to verify WebSocket lifecycle state.
     */
    isWebSocketListening(): boolean {
        return this.wsServer !== undefined;
    }

    /**
     * Get the TCP port the gateway is listening on.
     * WHY: When using port 0 (auto-assign), tests need to know the actual port.
     */
    getPort(): number | undefined {
        return this.tcpPort;
    }

    /**
     * Get the WebSocket port the gateway is listening on.
     * WHY: When using port 0 (auto-assign), tests need to know the actual port.
     */
    getWebSocketPort(): number | undefined {
        return this.wsPort;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Start listening for external connections on TCP and optionally WebSocket.
     *
     * ALGORITHM:
     * 1. Reset shutdown flag (allows restart after shutdown)
     * 2. Create TCP listener and start accept loop
     * 3. If wsPort specified, create WebSocket server and start accept loop
     * 4. Return the TCP port (primary port for backwards compatibility)
     *
     * @param tcpPort - TCP port to listen on (use 0 for auto-assign)
     * @param wsPort - WebSocket port to listen on (optional, use 0 for auto-assign)
     * @returns The actual TCP port the gateway is listening on
     */
    async listen(tcpPort: number, wsPort?: number): Promise<number> {
        // Reset shutdown flag in case gateway is being restarted
        this.shuttingDown = false;

        // Create TCP listener
        this.tcpListener = await this.hal.network.listen(tcpPort);
        this.tcpPort = this.tcpListener.port;

        // Start TCP accept loop (fire-and-forget)
        this.tcpAcceptLoop();

        // Create WebSocket server if port specified
        if (wsPort !== undefined) {
            this.wsServer = await this.hal.network.listenWebSocket(wsPort, {
                maxPayloadLength: MAX_READ_BUFFER_SIZE,
            });
            this.wsPort = this.wsServer.port;

            // Start WebSocket accept loop (fire-and-forget)
            this.wsAcceptLoop();
        }

        return this.tcpListener.port;
    }

    /**
     * Shutdown the gateway and disconnect all clients.
     *
     * ALGORITHM:
     * 1. Set shuttingDown flag (so accept loops know this is intentional)
     * 2. Close TCP listener (stops new connections, causes accept() to throw)
     * 3. Close WebSocket server (stops new connections, causes accept() to throw)
     * 4. Close all TCP client sockets
     * 5. Close all WebSocket client connections
     *
     * RC-1 FIX: Copy Sets before iteration to avoid mutation during iteration.
     */
    async shutdown(): Promise<void> {
        // Set flag first so accept loop catch blocks know this is intentional
        this.shuttingDown = true;

        // Close TCP listener to prevent new connections
        if (this.tcpListener) {
            await this.tcpListener.close();
            this.tcpListener = undefined;
            this.tcpPort = undefined;
        }

        // Close WebSocket server to prevent new connections
        if (this.wsServer) {
            await this.wsServer.close();
            this.wsServer = undefined;
            this.wsPort = undefined;
        }

        // RC-1 FIX: Copy Sets before iteration to avoid mutation during iteration.
        // Handler finally blocks delete from these Sets, which would corrupt
        // iteration if we iterated directly.
        const tcpClientsCopy = [...this.tcpClients];
        const wsClientsCopy = [...this.wsClients];

        // Close all TCP clients
        for (const socket of tcpClientsCopy) {
            try {
                await socket.close();
            }
            catch {
                // May already be closed by handler
            }
        }

        // Close all WebSocket clients
        for (const ws of wsClientsCopy) {
            try {
                ws.close(1001, 'Server shutting down');
            }
            catch {
                // May already be closed by handler
            }
        }

        this.tcpClients.clear();
        this.wsClients.clear();
    }

    // =========================================================================
    // TCP ACCEPT LOOP
    // =========================================================================

    /**
     * TCP accept loop - handles incoming TCP connections.
     *
     * RC-2 FIX: Store listener reference before loop to avoid checking
     * this.tcpListener after await (it could be set to undefined by shutdown()).
     */
    private async tcpAcceptLoop(): Promise<void> {
        // RC-2: Capture reference before entering loop
        const listener = this.tcpListener;

        if (!listener) {
            return;
        }

        try {
            // Loop until listener.accept() throws (closed by shutdown)
            while (true) {
                const socket = await listener.accept();

                this.tcpClients.add(socket);

                // Handle client (fire-and-forget)
                this.handleTcpClient(socket).finally(() => {
                    this.tcpClients.delete(socket);
                });
            }
        }
        catch (err) {
            // Only log if this wasn't a clean shutdown
            if (!this.shuttingDown) {
                const error = err as Error;

                console.error(`Gateway TCP accept error: ${error.message}`);
            }
        }
    }

    // =========================================================================
    // WEBSOCKET ACCEPT LOOP
    // =========================================================================

    /**
     * WebSocket accept loop - handles incoming WebSocket connections.
     *
     * RC-2 FIX: Store server reference before loop to avoid checking
     * this.wsServer after await (it could be set to undefined by shutdown()).
     */
    private async wsAcceptLoop(): Promise<void> {
        // RC-2: Capture reference before entering loop
        const server = this.wsServer;

        if (!server) {
            return;
        }

        try {
            // Loop until server.accept() throws (closed by shutdown)
            while (true) {
                const ws = await server.accept();

                this.wsClients.add(ws);

                // Handle client (fire-and-forget)
                this.handleWebSocketClient(ws).finally(() => {
                    this.wsClients.delete(ws);
                });
            }
        }
        catch (err) {
            // Only log if this wasn't a clean shutdown
            if (!this.shuttingDown) {
                const error = err as Error;

                console.error(`Gateway WebSocket accept error: ${error.message}`);
            }
        }
    }

    // =========================================================================
    // TCP CLIENT HANDLING
    // =========================================================================

    /**
     * Handle a connected TCP client.
     *
     * Creates a virtual process for isolation, then reads length-prefixed
     * msgpack messages and dispatches syscalls.
     *
     * ALGORITHM:
     * 1. Create virtual process for isolation
     * 2. Create send function that writes length-prefixed frames
     * 3. Read loop: accumulate chunks, extract complete messages
     * 4. For each message: fire-and-forget dispatch to processMessage
     * 5. On disconnect: cancel streams, destroy process, close socket
     *
     * @param socket - Client socket
     */
    private async handleTcpClient(socket: Socket): Promise<void> {
        // Generate unique client ID (used for debugging/logging)
        const clientId = this.nextClientId++;

        // Get init process as parent for virtual processes
        const init = this.kernel.processes.getInit();

        if (!init) {
            // Kernel not booted - reject connection
            await socket.close();

            return;
        }

        // Create virtual process for this connection (INV-1)
        const { id: procId } = createVirtualProcess(this.kernel, init, {
            cwd: '/',
            env: { ...init.env },
        });

        const proc = this.kernel.processes.get(procId);

        if (!proc) {
            await socket.close();

            return;
        }

        debug('tcp:connect', `client=${clientId} proc=${procId}`);

        // Create send function for TCP (length-prefixed msgpack)
        const send: SendFn = async (id, response) => {
            return this.sendTcpResponse(socket, id, response);
        };

        const sendError: SendErrorFn = async (id, code, message) => {
            return this.sendTcpError(socket, id, code, message);
        };

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

                // Buffer overflow protection - send error before disconnecting (INV-4)
                if (readBuffer.length > MAX_READ_BUFFER_SIZE) {
                    await sendError('overflow', 'ENOMEM', 'Read buffer overflow');
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

                    debug('tcp:recv', `client=${clientId} ${payload.length} bytes`);

                    // Fire-and-forget dispatch
                    this.processMessage(send, sendError, proc, clientId, payload, () => disconnecting).catch(() => {
                        // Dispatch errors handled inside processMessage
                    });
                }
            }
        }
        finally {
            disconnecting = true;
            debug('tcp:disconnect', `client=${clientId}`);

            // Cancel active streams (INV-3)
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
    // WEBSOCKET CLIENT HANDLING
    // =========================================================================

    /**
     * Handle a connected WebSocket client.
     *
     * Creates a virtual process for isolation, then iterates msgpack
     * messages from the WebSocket and dispatches syscalls.
     *
     * ALGORITHM:
     * 1. Create virtual process for isolation
     * 2. Create send function that writes raw msgpack (no length prefix)
     * 3. Message loop: iterate WebSocket binary messages
     * 4. For each message: fire-and-forget dispatch to processMessage
     * 5. On disconnect: cancel streams, destroy process, close WebSocket
     *
     * @param ws - WebSocket connection
     */
    private async handleWebSocketClient(ws: WebSocketConnection): Promise<void> {
        // Generate unique client ID (used for debugging/logging)
        const clientId = this.nextClientId++;

        // Get init process as parent for virtual processes
        const init = this.kernel.processes.getInit();

        if (!init) {
            // Kernel not booted - reject connection
            ws.close(1013, 'Kernel not ready');

            return;
        }

        // Create virtual process for this connection (INV-1)
        const { id: procId } = createVirtualProcess(this.kernel, init, {
            cwd: '/',
            env: { ...init.env },
        });

        const proc = this.kernel.processes.get(procId);

        if (!proc) {
            ws.close(1011, 'Internal error');

            return;
        }

        debug('ws:connect', `client=${clientId} proc=${procId} remote=${ws.remoteAddress}`);

        // Create send function for WebSocket (raw msgpack, no length prefix)
        const send: SendFn = async (id, response) => {
            return this.sendWebSocketResponse(ws, id, response);
        };

        const sendError: SendErrorFn = async (id, code, message) => {
            return this.sendWebSocketError(ws, id, code, message);
        };

        let disconnecting = false;

        try {
            // Message loop - iterate WebSocket binary messages
            for await (const payload of ws) {
                if (disconnecting) {
                    break;
                }

                debug('ws:recv', `client=${clientId} ${payload.length} bytes`);

                // Fire-and-forget dispatch
                this.processMessage(send, sendError, proc, clientId, payload, () => disconnecting).catch(() => {
                    // Dispatch errors handled inside processMessage
                });
            }
        }
        finally {
            disconnecting = true;
            debug('ws:disconnect', `client=${clientId}`);

            // Cancel active streams (INV-3)
            for (const abort of proc.activeStreams.values()) {
                abort.abort();
            }

            proc.activeStreams.clear();
            proc.streamPingHandlers.clear();

            // Destroy virtual process (INV-2)
            forceExit(this.kernel, proc, 0);

            // Close WebSocket
            try {
                ws.close(1000, 'Client disconnected');
            }
            catch {
                // May already be closed
            }
        }
    }

    // =========================================================================
    // MESSAGE PROCESSING (transport-agnostic)
    // =========================================================================

    /**
     * Process a single msgpack message from client.
     *
     * This method is transport-agnostic - it receives send functions that
     * abstract whether we're sending over TCP (length-prefixed) or WebSocket
     * (raw binary frames).
     *
     * ALGORITHM:
     * 1. Decode msgpack payload
     * 2. Validate required fields (id, call)
     * 3. Check disconnect state
     * 4. Dispatch syscall via dispatcher.execute()
     * 5. Stream responses back via send function
     * 6. Break on terminal ops (ok, error, done, redirect)
     *
     * @param send - Transport-specific send function
     * @param sendError - Transport-specific error send function
     * @param proc - Virtual process for this client
     * @param clientId - Client identifier for logging
     * @param payload - Raw msgpack payload
     * @param isDisconnecting - Function to check disconnect state
     */
    private async processMessage(
        send: SendFn,
        sendError: SendErrorFn,
        proc: Process,
        clientId: number,
        payload: Uint8Array,
        isDisconnecting: () => boolean,
    ): Promise<void> {
        // Decode msgpack
        let msg: { id?: string; call?: string; args?: unknown[] };

        try {
            msg = unpack(payload);
            debugDecode(msg);
        }
        catch {
            await sendError('parse', 'EINVAL', 'Invalid msgpack');

            return;
        }

        const id = msg.id ?? 'unknown';

        // Validate required fields
        if (!msg.call) {
            await sendError(id, 'EINVAL', 'Missing "call" field');

            return;
        }

        // RC-3: Check disconnect state after every await
        if (isDisconnecting()) {
            return;
        }

        // Args are passed directly - msgpack preserves Uint8Array natively
        const args = msg.args ?? [];

        // Dispatch syscall and stream responses
        try {
            for await (const response of this.dispatcher.execute(proc, id, msg.call, args)) {
                // RC-3: Check disconnect state after every await
                if (isDisconnecting()) {
                    break;
                }

                debug('send', `id=${id} op=${response.op}`);

                const sent = await send(id, response);

                if (!sent) {
                    break;
                }

                // Terminal ops end stream (INV-6)
                if (response.op === 'ok' || response.op === 'error' ||
                    response.op === 'done' || response.op === 'redirect') {
                    break;
                }
            }
        }
        catch (err) {
            const error = err as Error & { code?: string };

            if (!isDisconnecting()) {
                await sendError(id, error.code ?? 'EIO', error.message);
            }
        }
    }

    // =========================================================================
    // TCP RESPONSE HELPERS
    // =========================================================================

    /**
     * Send a syscall response to TCP client.
     *
     * Writes length-prefixed msgpack frame: [4-byte BE length][msgpack]
     *
     * @returns true if sent, false if socket dead
     */
    private async sendTcpResponse(socket: Socket, id: string, response: Response): Promise<boolean> {
        const wireResponse = this.prepareForWire(id, response);

        return this.sendTcpFrame(socket, wireResponse);
    }

    /**
     * Send an error response to TCP client.
     *
     * @returns true if sent, false if socket dead
     */
    private async sendTcpError(socket: Socket, id: string, code: string, message: string): Promise<boolean> {
        return this.sendTcpFrame(socket, { id, op: 'error', code, message });
    }

    /**
     * Send a length-prefixed msgpack frame to TCP socket.
     *
     * @returns true if write succeeded, false otherwise
     */
    private async sendTcpFrame(socket: Socket, data: unknown): Promise<boolean> {
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
    // WEBSOCKET RESPONSE HELPERS
    // =========================================================================

    /**
     * Send a syscall response to WebSocket client.
     *
     * Writes raw msgpack (no length prefix - WebSocket handles framing).
     *
     * @returns true if sent, false if connection dead
     */
    private sendWebSocketResponse(ws: WebSocketConnection, id: string, response: Response): Promise<boolean> {
        const wireResponse = this.prepareForWire(id, response);
        const payload = pack(wireResponse);

        // sendBinary is synchronous, wrap in Promise for consistent API
        return Promise.resolve(ws.sendBinary(payload));
    }

    /**
     * Send an error response to WebSocket client.
     *
     * @returns true if sent, false if connection dead
     */
    private sendWebSocketError(ws: WebSocketConnection, id: string, code: string, message: string): Promise<boolean> {
        const payload = pack({ id, op: 'error', code, message });

        return Promise.resolve(ws.sendBinary(payload));
    }

    // =========================================================================
    // RESPONSE PREPARATION (shared)
    // =========================================================================

    /**
     * Prepare response for msgpack wire format.
     *
     * Flattens kernel Response into: { id, op, ...fields }
     * Uint8Array passes through directly (msgpack handles binary natively).
     *
     * WHY: Both TCP and WebSocket use the same msgpack format,
     * only the framing differs.
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
