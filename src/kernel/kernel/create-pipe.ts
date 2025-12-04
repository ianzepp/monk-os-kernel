/**
 * Pipe Creation - Create bidirectional message pipe
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Creates a pair of connected handles (pipe ends) for message-based
 * inter-process communication. Unlike UNIX pipes (byte streams), these are
 * message pipes: Each write sends a structured Response object.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Pipe creation is atomic (both ends allocated or neither)
 *        VIOLATED BY: Partial allocation on error, leaving orphan handle
 * INV-2: Both pipe ends share the same pipe ID (for debugging)
 *        VIOLATED BY: Using different IDs for each end
 * INV-3: Each pipe end has exactly one fd and refcount=1
 *        VIOLATED BY: Sharing pipe ends, incorrect initial refcount
 * INV-4: Process never exceeds MAX_HANDLES after pipe creation
 *        VIOLATED BY: Skipping limit check before allocating
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points, no race conditions.
 *
 * Pipe I/O is async and uses message queuing:
 * - recv() waits for message from other end
 * - send() enqueues message to other end
 * - Backpressure handled by queue size limits
 *
 * MEMORY MANAGEMENT
 * =================
 * Pipe lifecycle:
 * 1. createPipe() allocates both ends, refcount=1 each
 * 2. Process uses fds for send/recv
 * 3. closeHandle(recvFd) → unref recv end → close when refcount=0
 * 4. closeHandle(sendFd) → unref send end → close when refcount=0
 *
 * WHY two separate handles:
 * Each end is independently closable. Close recv → other end gets EOF.
 * Close send → other end's recv gets closed pipe error.
 *
 * HANDLE SHARING:
 * Pipe ends can be shared across processes (via spawn with inherited fds).
 * Refcount ensures pipe stays alive until all references closed.
 *
 * @module kernel/kernel/create-pipe
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EMFILE } from '../errors.js';
import { MAX_HANDLES } from '../types.js';
import { createMessagePipe } from '../resource.js';
import { allocHandle } from './alloc-handle.js';

/**
 * Create a message pipe.
 *
 * ALGORITHM:
 * 1. Check process handle limit (need 2 fds)
 * 2. Generate unique pipe ID (for debugging)
 * 3. Create pipe ends (recv, send) via createMessagePipe()
 * 4. Allocate fd for recv end (sets refcount=1)
 * 5. Allocate fd for send end (sets refcount=1)
 * 6. Return [recvFd, sendFd]
 *
 * WHY check for 2 handles:
 * Pipe creation allocates both ends atomically. If only 1 fd available,
 * partial allocation would leak a handle (recv allocated but send fails).
 *
 * PIPE END SEMANTICS:
 * - recvFd: Read-only end, used for recv() operations
 * - sendFd: Write-only end, used for send() operations
 * - Both ends are Message handles (not byte handles)
 * - Messages preserve structure (no serialization until network boundary)
 *
 * ERROR HANDLING:
 * Throws EMFILE if process would exceed MAX_HANDLES. This is checked
 * before any allocation, so failure is clean (no cleanup needed).
 *
 * ATOMIC ALLOCATION:
 * If allocHandle() throws on second call (shouldn't happen - we checked size):
 * - First handle is already in kernel table with refcount=1
 * - Process cleanup will eventually unref it
 * - Not ideal but not a leak (will be GC'd on process exit)
 *
 * USAGE PATTERN:
 * ```typescript
 * // Create pipe
 * const [recvFd, sendFd] = createPipe(kernel, proc);
 *
 * // Send message
 * await send(sendFd, { type: 'data', value: 42 });
 *
 * // Receive message
 * for await (const msg of recv(recvFd)) {
 *   console.log(msg); // { op: 'item', data: { type: 'data', value: 42 } }
 * }
 *
 * // Cleanup
 * await close(recvFd);
 * await close(sendFd);
 * ```
 *
 * CROSS-PROCESS PIPES:
 * Pipe ends can be passed to child processes via spawn():
 * ```typescript
 * const [recvFd, sendFd] = createPipe(kernel, parent);
 * await spawn('/bin/worker', {
 *   fds: { 0: recvFd, 1: sendFd }  // Child's stdin/stdout
 * });
 * // Parent and child now share pipe (refcount=2 per end)
 * ```
 *
 * @param self - Kernel instance
 * @param proc - Process owning the pipe
 * @returns [recvFd, sendFd] - Tuple of file descriptors
 * @throws EMFILE if process would exceed MAX_HANDLES
 */
export function createPipe(self: Kernel, proc: Process): [number, number] {
    // Check limit before allocation (need 2 handles)
    // WHY +2: Both pipe ends will consume one fd each
    if (proc.handles.size + 2 > MAX_HANDLES) {
        throw new EMFILE('Too many open handles');
    }

    // Generate unique ID for pipe (debugging only, not functional)
    // Both ends share this ID to identify paired handles
    const pipeId = self.hal.entropy.uuid();

    // Create pipe ends (connected message queues)
    const [recvEnd, sendEnd] = createMessagePipe(pipeId);

    // Allocate fds for both ends
    // Each allocHandle() sets refcount=1 and registers in kernel table
    const recvFd = allocHandle(self, proc, recvEnd);
    const sendFd = allocHandle(self, proc, sendEnd);

    return [recvFd, sendFd];
}
