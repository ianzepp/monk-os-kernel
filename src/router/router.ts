/**
 * Router - Syscall message routing and streaming layer
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Router sits between userland processes and the kernel. It receives
 * messages from worker processes, routes them to the appropriate kernel
 * operations, and manages the response streaming protocol with backpressure.
 *
 * The Router does NOT:
 * - Own process state (that's the kernel's job)
 * - Implement syscall logic (that's KernelOps)
 * - Manage workers (that's the kernel's job)
 *
 * The Router DOES:
 * - Parse and validate incoming messages
 * - Route syscalls to KernelOps methods
 * - Apply backpressure via StreamController
 * - Handle stream_ping and stream_cancel messages
 * - Convert exceptions to error responses
 * - Track active streams per process
 *
 * STATE MACHINE
 * =============
 * Per-request lifecycle:
 *
 *   [IDLE] ──syscall──> [DISPATCHING] ──> [STREAMING] ──> [DONE]
 *                                             │
 *                                             │ cancel/error
 *                                             ▼
 *                                         [ABORTED]
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Each active stream has a StreamController in processStreams
 * INV-2: StreamController is deleted from processStreams on completion
 * INV-3: Terminal responses (ok/error/done/redirect) end the stream
 * INV-4: Ping/cancel messages are only valid for active streams
 *
 * CONCURRENCY MODEL
 * =================
 * The router runs in the kernel's main thread. Multiple syscalls from
 * different processes can be in flight concurrently (async interleaving).
 * Each syscall has its own StreamController, keyed by (pid, requestId).
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Process killed while stream active → Caller checks proc.state
 * RC-2: Stream cancelled while iterating → StreamController.abort
 * RC-3: Ping for unknown stream → Ignored with warning
 *
 * @module router/router
 */

import type { Response } from '../message.js';
import { respond } from '../message.js';
import type {
    RouterDeps,
    ProcessContext,
    KernelMessage,
    SyscallRequest,
    KernelOps,
    SyscallName,
} from './types.js';
import { StreamController, StallError } from './stream/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Function to look up a process by ID.
 */
export type ProcessLookup = (pid: string) => ProcessContext | undefined;

/**
 * Function to send a response to a process.
 */
export type ResponseSender = (proc: ProcessContext, requestId: string, response: Response) => void;

/**
 * Function to log kernel messages.
 */
export type PrintkFn = (category: string, message: string) => void;

/**
 * Map of stream controllers keyed by request ID.
 */
type StreamMap = Map<string, StreamController>;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a response op is terminal (ends the stream).
 */
function isTerminal(op: string): boolean {
    return op === 'ok' || op === 'error' || op === 'done' || op === 'redirect';
}

/**
 * Create default router dependencies.
 */
function createDefaultDeps(): RouterDeps {
    return {
        now: () => Date.now(),
        setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
        clearTimeout: (id) => globalThis.clearTimeout(id),
    };
}

// =============================================================================
// ROUTER CLASS
// =============================================================================

/**
 * Routes syscall messages to kernel operations with streaming support.
 *
 * USAGE:
 * ```typescript
 * const router = new Router(kernelOps, {
 *     lookupProcess: (pid) => kernel.processes.get(pid),
 *     sendResponse: (proc, id, res) => proc.worker.postMessage(...),
 *     printk: (cat, msg) => console.log(`[${cat}] ${msg}`),
 * });
 *
 * worker.onmessage = (event) => {
 *     router.handleMessage(event.data);
 * };
 * ```
 */
export class Router {
    // =========================================================================
    // DEPENDENCIES
    // =========================================================================

    private readonly kernel: KernelOps;
    private readonly deps: RouterDeps;
    private readonly lookupProcess: ProcessLookup;
    private readonly sendResponse: ResponseSender;
    private readonly printk: PrintkFn;

    // =========================================================================
    // STATE
    // =========================================================================

    /**
     * Active stream controllers per process.
     *
     * Key: process ID
     * Value: Map of request ID → StreamController
     *
     * WHY nested map: Each process can have multiple concurrent streams.
     * Outer map enables O(1) cleanup when process exits.
     */
    private readonly processStreams = new Map<string, StreamMap>();

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a new Router.
     *
     * @param kernel - KernelOps implementation
     * @param callbacks - Process lookup, response sending, and logging
     * @param deps - Injectable dependencies for testing
     */
    constructor(
        kernel: KernelOps,
        callbacks: {
            lookupProcess: ProcessLookup;
            sendResponse: ResponseSender;
            printk: PrintkFn;
        },
        deps?: Partial<RouterDeps>,
    ) {
        this.kernel = kernel;
        this.lookupProcess = callbacks.lookupProcess;
        this.sendResponse = callbacks.sendResponse;
        this.printk = callbacks.printk;
        this.deps = { ...createDefaultDeps(), ...deps };
    }

    // =========================================================================
    // PUBLIC METHODS - MESSAGE HANDLING
    // =========================================================================

    /**
     * Handle a message from a worker process.
     *
     * ALGORITHM:
     * 1. Extract process ID from message
     * 2. Look up process
     * 3. Validate process state
     * 4. Dispatch by message type
     *
     * @param msg - Message from worker
     * @param validateWorker - Optional function to validate worker ownership
     */
    async handleMessage(
        msg: KernelMessage,
        validateWorker?: (proc: ProcessContext) => boolean,
    ): Promise<void> {
        // Extract process ID
        let pid: string | undefined;

        if (msg.type === 'syscall') {
            pid = (msg as SyscallRequest).pid;
        }
        else {
            // Stream messages: find process that owns this stream
            pid = this.findStreamOwner(msg.id);
        }

        if (!pid) {
            this.printk('warn', `Message without process ID: ${msg.type}`);

            return;
        }

        const proc = this.lookupProcess(pid);

        if (!proc) {
            this.printk('warn', `Message for unknown process: ${pid}`);

            return;
        }

        // Validate worker ownership if callback provided
        if (validateWorker && !validateWorker(proc)) {
            this.printk('warn', `Worker mismatch for process ${pid}`);

            if (msg.type === 'syscall') {
                this.sendResponse(proc, (msg as SyscallRequest).id, respond.error('EPERM', 'Worker mismatch'));
            }

            return;
        }

        // Check process state
        if (proc.state === 'zombie') {
            return;
        }

        // Dispatch by type
        switch (msg.type) {
            case 'syscall':
                await this.handleSyscall(proc, msg as SyscallRequest);
                break;

            case 'stream_ping':
                this.handlePing(proc.id, msg.id, msg.processed);
                break;

            case 'stream_cancel':
                this.handleCancel(proc.id, msg.id);
                break;
        }
    }

    /**
     * Clean up all streams for a process.
     *
     * Call this when a process exits to abort all pending streams.
     *
     * @param pid - Process ID
     */
    cleanupProcess(pid: string): void {
        const streams = this.processStreams.get(pid);

        if (!streams) {
            return;
        }

        for (const controller of streams.values()) {
            controller.onCancel();
        }

        this.processStreams.delete(pid);
    }

    // =========================================================================
    // PRIVATE METHODS - SYSCALL HANDLING
    // =========================================================================

    /**
     * Handle a syscall request.
     *
     * ALGORITHM:
     * 1. Create StreamController for backpressure
     * 2. Register controller in processStreams
     * 3. Look up kernel method
     * 4. Iterate with controller.wrap() for backpressure
     * 5. Send each response to process
     * 6. Stop on terminal response
     * 7. Cleanup in finally block
     *
     * @param proc - Process context
     * @param request - Syscall request
     */
    private async handleSyscall(proc: ProcessContext, request: SyscallRequest): Promise<void> {
        this.printk('syscall', `${proc.id}: ${request.name}`);

        // Create stream controller
        const controller = new StreamController(this.deps);

        // Register for ping/cancel
        this.registerStream(proc.id, request.id, controller);

        try {
            // Look up kernel method
            // WHY cast via unknown: KernelOps methods have heterogeneous signatures.
            // Runtime validation happens in handlers; router just dispatches.
            const kernel = this.kernel as unknown as Record<string, (proc: ProcessContext, ...args: unknown[]) => AsyncIterable<Response>>;
            const handler = kernel[request.name];

            if (!handler) {
                this.sendResponse(proc, request.id, respond.error('ENOSYS', `Unknown syscall: ${request.name}`));

                return;
            }

            // Execute syscall and stream responses
            const source = handler(proc, ...request.args);

            for await (const response of controller.wrap(source)) {
                // Check process state after each await
                if (proc.state === 'zombie') {
                    this.printk('syscall', `${proc.id}: ${request.name} -> process zombie`);
                    break;
                }

                // Send response
                this.sendResponse(proc, request.id, response);

                // Terminal ops end stream
                if (isTerminal(response.op)) {
                    this.printk('syscall', `${proc.id}: ${request.name} -> ${response.op}`);

                    return;
                }
            }
        }
        catch (err) {
            // Handle stall errors specially
            if (err instanceof StallError) {
                this.sendResponse(proc, request.id, respond.error('ETIMEDOUT', err.message));
                this.printk('syscall', `${proc.id}: ${request.name} -> timeout`);

                return;
            }

            // Convert other exceptions to error responses
            const error = err as Error & { code?: string };

            this.sendResponse(proc, request.id, respond.error(error.code ?? 'EIO', error.message));
            this.printk('syscall', `${proc.id}: ${request.name} -> error: ${error.code ?? 'EIO'}`);
        }
        finally {
            // Cleanup stream controller
            this.unregisterStream(proc.id, request.id);
        }
    }

    // =========================================================================
    // PRIVATE METHODS - STREAM MANAGEMENT
    // =========================================================================

    /**
     * Handle stream ping (backpressure acknowledgement).
     *
     * @param pid - Process ID
     * @param requestId - Request ID
     * @param processed - Number of items processed by consumer
     */
    private handlePing(pid: string, requestId: string, processed: number): void {
        const controller = this.getController(pid, requestId);

        if (controller) {
            controller.onPing(processed);
        }
    }

    /**
     * Handle stream cancel (consumer abort).
     *
     * @param pid - Process ID
     * @param requestId - Request ID
     */
    private handleCancel(pid: string, requestId: string): void {
        const controller = this.getController(pid, requestId);

        if (controller) {
            controller.onCancel();
        }
    }

    /**
     * Register a stream controller.
     *
     * @param pid - Process ID
     * @param requestId - Request ID
     * @param controller - Stream controller
     */
    private registerStream(pid: string, requestId: string, controller: StreamController): void {
        let streams = this.processStreams.get(pid);

        if (!streams) {
            streams = new Map();
            this.processStreams.set(pid, streams);
        }

        streams.set(requestId, controller);
    }

    /**
     * Unregister a stream controller.
     *
     * @param pid - Process ID
     * @param requestId - Request ID
     */
    private unregisterStream(pid: string, requestId: string): void {
        const streams = this.processStreams.get(pid);

        if (streams) {
            streams.delete(requestId);

            if (streams.size === 0) {
                this.processStreams.delete(pid);
            }
        }
    }

    /**
     * Get a stream controller by process and request ID.
     *
     * @param pid - Process ID
     * @param requestId - Request ID
     * @returns Controller or undefined
     */
    private getController(pid: string, requestId: string): StreamController | undefined {
        return this.processStreams.get(pid)?.get(requestId);
    }

    /**
     * Find the process that owns a stream.
     *
     * Used for stream_ping and stream_cancel messages that don't include pid.
     *
     * @param requestId - Request ID
     * @returns Process ID or undefined
     */
    private findStreamOwner(requestId: string): string | undefined {
        for (const [pid, streams] of this.processStreams) {
            if (streams.has(requestId)) {
                return pid;
            }
        }

        return undefined;
    }

    // =========================================================================
    // PUBLIC ACCESSORS (for testing)
    // =========================================================================

    /**
     * Get the number of active streams for a process.
     *
     * TESTING: Allows tests to verify cleanup.
     */
    getActiveStreamCount(pid: string): number {
        return this.processStreams.get(pid)?.size ?? 0;
    }

    /**
     * Get total active streams across all processes.
     *
     * TESTING: Allows tests to verify no leaks.
     */
    getTotalStreamCount(): number {
        let total = 0;

        for (const streams of this.processStreams.values()) {
            total += streams.size;
        }

        return total;
    }
}
