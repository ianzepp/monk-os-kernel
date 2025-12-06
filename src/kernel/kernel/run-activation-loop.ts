/**
 * Activation Loop - Event-driven service handler spawning
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements the activation loop for socket-activated services.
 * It receives events from a Port (TCP connections, UDP datagrams, pubsub
 * messages, file watch events) and spawns a service handler process for
 * each event.
 *
 * The loop runs until the AbortController signals cancellation (service stop).
 * When an event arrives, a transform function extracts the socket (if any)
 * and builds an activation message. The handler is then spawned with this
 * context.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Loop terminates when signal.aborted is true
 *        VIOLATED BY: Not checking signal.aborted after await points
 * INV-2: Sockets from Port are either passed to handler OR closed on error
 *        VIOLATED BY: Not closing socket when spawn fails
 * INV-3: Transform returns null for invalid messages (filtered out)
 *        VIOLATED BY: Transform throwing instead of returning null
 * INV-4: Loop continues on spawn failure (doesn't crash service)
 *        VIOLATED BY: Not catching spawn errors
 *
 * CONCURRENCY MODEL
 * =================
 * - Loop runs in single async context, but handlers spawn concurrently
 * - Port.recv() serializes event delivery (one at a time)
 * - spawnServiceHandler runs async without await (fire-and-forget)
 * - Multiple handlers can run concurrently for same service
 * - AbortController signals cancellation from external context
 *
 * NOTE: Bun workers are truly parallel (separate threads), not just async.
 * postMessage crosses thread boundaries. The kernel runs in the main thread
 * while each process runs in its own worker thread.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: Service stopped while waiting for event
 *       MITIGATION: Check signal.aborted after port.recv() returns
 * RC-2: Handler spawn fails after accepting socket
 *       MITIGATION: Socket closed in catch block, logged but doesn't crash loop
 * RC-3: Port.recv() throws on error (port closed, network error)
 *       MITIGATION: Catch outer loop errors, log if not aborted
 *
 * MEMORY MANAGEMENT
 * =================
 * - Socket lifecycle: received from Port -> passed to handler OR closed on error
 * - Transform function is synchronous (no cleanup needed)
 * - Spawn errors caught and logged (socket closed in error handler)
 * - Loop terminates when aborted (no infinite resource consumption)
 *
 * TESTABILITY
 * ===========
 * - Port interface allows mocking event sources
 * - Transform function is pure (testable independently)
 * - AbortController allows external cancellation for testing
 * - Spawn errors caught (testable via mock that throws)
 *
 * @module kernel/kernel/run-activation-loop
 */

import type { Kernel } from '../kernel.js';
import type { ServiceDef } from '../services.js';
import type { Port, PortMessage } from '../resource.js';
import type { Socket } from '../../hal/network.js';
import type { Message } from '../../message.js';
import { spawnServiceHandler } from './spawn-service-handler.js';
import { logServiceError } from './log-service-error.js';
import { printk } from './printk.js';
import { formatError } from './format-error.js';

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Unified activation loop for services.
 *
 * ALGORITHM:
 * 1. Loop until signal.aborted
 * 2. Wait for event from Port (blocking)
 * 3. Check if aborted after receive
 * 4. Transform event to socket/activation message
 * 5. Spawn handler with context (async, fire-and-forget)
 * 6. On spawn error, close socket and log (don't crash loop)
 *
 * RACE CONDITION: Service stopped while waiting for event
 * MITIGATION: Check signal.aborted immediately after port.recv() returns
 *
 * RACE CONDITION: Handler spawn fails after accepting socket
 * MITIGATION: Socket closed in catch block (prevents leak)
 *
 * @param self - Kernel instance
 * @param name - Service name
 * @param def - Service definition
 * @param port - Activation port (listener/watcher/subscriber)
 * @param signal - Abort signal for cancellation
 * @param transform - Transform PortMessage to socket/activation (returns null to skip)
 */
export async function runActivationLoop(
    self: Kernel,
    name: string,
    def: ServiceDef,
    port: Port,
    signal: AbortSignal,
    transform: (msg: PortMessage) => {
        socket?: Socket;
        activation?: Message;
    } | null,
): Promise<void> {
    try {
        // -------------------------------------------------------------------------
        // Main activation loop
        // -------------------------------------------------------------------------

        while (!signal.aborted) {
            // WHY: Block until event arrives (connection/message/watch event)
            const msg = await port.recv();

            // RACE FIX: Check if service was stopped while waiting for event
            if (signal.aborted) {
                if (msg.socket) {
                    // ---------------------------------------------------------
                    // FIRE-AND-FORGET: socket.close() on service abort
                    // ---------------------------------------------------------
                    //
                    // WHAT: Close the accepted socket without propagating errors.
                    //
                    // WHY: Service is stopping. We received a connection but can't
                    // handle it. Must close to avoid leaking the socket.
                    //
                    // TRADE-OFF: If close fails, socket may leak until OS cleanup.
                    // Acceptable because service is stopping anyway.
                    //
                    await msg.socket.close().catch(err => {
                        printk(self, 'cleanup', `socket close on abort: ${formatError(err)}`);
                    });
                }

                break;
            }

            // -------------------------------------------------------------------------
            // Transform event to handler input
            // -------------------------------------------------------------------------

            // WHY: Transform extracts socket and builds activation message
            //      Returns null for invalid/filtered events
            const input = transform(msg);

            if (input) {
                // ---------------------------------------------------------------------
                // FIRE-AND-FORGET: spawnServiceHandler()
                // ---------------------------------------------------------------------
                //
                // WHAT: Spawn a handler process for this event without awaiting.
                // Multiple handlers can run concurrently for the same service.
                //
                // WHY: The activation loop must remain responsive. If we awaited each
                // handler, we could only process one event at a time. Fire-and-forget
                // allows the loop to immediately accept the next connection.
                //
                // TRADE-OFF: Handler failures don't block the loop, but they also
                // don't stop the service. A repeatedly crashing handler will keep
                // accepting connections and failing.
                //
                // MITIGATION: Errors are logged for visibility. On spawn failure, we
                // close the socket to prevent resource leaks. The handler process
                // itself manages its own lifecycle.
                //
                spawnServiceHandler(self, name, def, input.socket, input.activation).catch(err => {
                    logServiceError(self, name, 'spawn failed', err);

                    // Close socket on spawn failure to prevent leak
                    // This is also fire-and-forget - we're in an error path already
                    if (input.socket) {
                        input.socket.close().catch(closeErr => {
                            printk(self, 'cleanup', `socket close on error: ${formatError(closeErr)}`);
                        });
                    }
                });
            }
        }
    }
    catch (err) {
        // -------------------------------------------------------------------------
        // Port error handling
        // -------------------------------------------------------------------------

        // WHY: Port.recv() may throw (port closed, network error, etc.)
        //      Log error unless service was intentionally stopped
        if (!signal.aborted) {
            logServiceError(self, name, 'activation loop error', err);
        }
    }
}
