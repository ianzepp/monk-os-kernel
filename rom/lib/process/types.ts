/**
 * Process Library Types
 *
 * Wire format types for kernel-process communication.
 * These define the syscall protocol between userspace and kernel.
 *
 * WHY DUPLICATED: Userspace code cannot import from @src/ at runtime.
 * The VFS loader only understands @rom/ paths. These types must exist
 * locally for the process library to be self-contained.
 *
 * @module process/types
 */

// =============================================================================
// SYSCALL MESSAGES
// =============================================================================

/**
 * Syscall request message sent from process to kernel via postMessage.
 */
export interface SyscallRequest {
    type: 'syscall';
    id: string;
    name: string;
    args: unknown[];
}

/**
 * Syscall response message sent from kernel to process.
 */
export interface SyscallResponse {
    type: 'response';
    id: string;
    result?: Response;
    error?: { code: string; message: string };
}

/**
 * Signal message sent from kernel to process.
 */
export interface SignalMessage {
    type: 'signal';
    signal: number;
}

/**
 * Stream ping message for backpressure acknowledgment.
 */
export interface StreamPingMessage {
    type: 'stream_ping';
    id: string;
    processed: number;
}

/**
 * Stream cancel message to abort a streaming syscall.
 */
export interface StreamCancelMessage {
    type: 'stream_cancel';
    id: string;
}

// =============================================================================
// RESPONSE TYPES
// =============================================================================

/**
 * Response from kernel operations.
 *
 * Terminal ops (ok, error, done, redirect) signal stream completion.
 * Non-terminal ops (item, data, event, progress) may yield multiple times.
 */
export interface Response {
    op: 'ok' | 'error' | 'item' | 'data' | 'event' | 'progress' | 'done' | 'redirect';
    data?: unknown;
    bytes?: Uint8Array;
}

/**
 * Message sent to a handler (channels, handles).
 */
export interface Message {
    op: string;
    data?: unknown;
}
