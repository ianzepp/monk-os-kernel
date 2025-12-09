/**
 * Prior Socket I/O - Low-level socket helpers for the Prior AI process
 *
 * PURPOSE
 * =======
 * Provides helper functions for reading and writing data to TCP sockets.
 * These are used by the HTTP layer before it hands off to the channel
 * abstraction.
 *
 * PROTOCOL
 * ========
 * Prior uses JSON lines over TCP. Each message is a single JSON object
 * terminated by a newline character.
 *
 * @module rom/lib/prior/socket
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { syscall } from '@rom/lib/process/index.js';

// =============================================================================
// SOCKET READING
// =============================================================================

/**
 * Read all data from a socket until connection closes or newline received.
 *
 * Uses the handle:send syscall to receive data chunks until we see
 * a newline (JSON lines protocol) or the connection closes.
 *
 * @param socketFd - The socket file descriptor
 * @returns The received data as a string (trimmed)
 * @throws Error if socket read fails
 */
export async function readSocket(socketFd: number): Promise<string> {
    const chunks: Uint8Array[] = [];

    for await (const response of syscall('handle:send', socketFd, { op: 'recv' })) {
        if (response.op === 'data' && response.bytes) {
            chunks.push(response.bytes);

            // Check for newline (JSON lines protocol)
            const lastChunk = response.bytes;
            if (lastChunk.includes(10)) { // \n
                break;
            }
        }
        else if (response.op === 'done' || response.op === 'ok') {
            break;
        }
        else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new Error(`Socket read error: ${err.code} - ${err.message}`);
        }
    }

    // Concatenate chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return new TextDecoder().decode(result).trim();
}

// =============================================================================
// SOCKET WRITING
// =============================================================================

/**
 * Write data to a socket.
 *
 * @param socketFd - The socket file descriptor
 * @param data - The string data to write
 * @throws Error if socket write fails
 */
export async function writeSocket(socketFd: number, data: string): Promise<void> {
    const bytes = new TextEncoder().encode(data);

    for await (const response of syscall('handle:send', socketFd, { op: 'send', data: { data: bytes } })) {
        if (response.op === 'ok') {
            return;
        }
        else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new Error(`Socket write error: ${err.code} - ${err.message}`);
        }
    }
}
