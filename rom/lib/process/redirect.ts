/**
 * Message Redirects - Bridge message↔byte boundary for shell redirects
 *
 * Pipes carry Response messages, files carry raw bytes. Shell redirects
 * (`>`, `>>`, `<`) cross that boundary. This module provides abstractions
 * that handle the conversion transparently.
 *
 * Output redirect (> file, >> file):
 *   Process sends messages → outputRedirect converts to bytes → file
 *
 * Input redirect (< file):
 *   File contains bytes → inputRedirect converts to messages → process
 *
 * @example
 * // Redirect process stdout to file
 * const redirect = await outputRedirect('/tmp/out');
 * const pid = await spawn('/bin/cmd', { stdout: redirect.fd });
 * await wait(pid);
 * await redirect.done;
 *
 * @example
 * // Redirect file to process stdin
 * const redirect = await inputRedirect('/tmp/in');
 * const pid = await spawn('/bin/cmd', { stdin: redirect.fd });
 * await redirect.done;
 * await wait(pid);
 *
 * @module rom/lib/process/redirect
 */

import { open, close, write, read } from './file';
import { pipe, recv, send } from './pipe';
import { respond } from './types';

/**
 * Result of creating a redirect.
 */
export interface RedirectHandle {
    /** Message fd to pass to the process */
    fd: number;

    /**
     * Start the pump. Call this AFTER spawning the process.
     * Returns a promise that resolves when the pump completes.
     */
    start: () => Promise<void>;
}

/**
 * Create an output redirect that converts messages to bytes.
 *
 * Creates a message pipe and returns the write end for the process.
 * Call start() AFTER spawning the process to begin pumping messages to file.
 *
 * @param path - Path to the output file
 * @param options - Redirect options
 * @param options.append - If true, append to file instead of truncating
 * @returns Handle with fd for process stdout and start() to begin pump
 *
 * @example
 * // cmd > /tmp/out
 * const redirect = await outputRedirect('/tmp/out');
 * await spawn('/bin/cmd', { stdout: redirect.fd });
 * await redirect.start();  // Start pump AFTER spawn
 *
 * @example
 * // cmd >> /tmp/out (append)
 * const redirect = await outputRedirect('/tmp/out', { append: true });
 * await spawn('/bin/cmd', { stdout: redirect.fd });
 * await redirect.start();
 */
export async function outputRedirect(
    path: string,
    options?: { append?: boolean },
): Promise<RedirectHandle> {
    const append = options?.append ?? false;

    // Open the output file
    const fileFd = await open(path, {
        write: true,
        create: true,
        truncate: !append,
        append: append,
    });

    // Create a message pipe for the process's stdout
    const [recvFd, sendFd] = await pipe();

    // Return handle with start function that kicks off the pump
    return {
        fd: sendFd,
        start: () => pumpMessagesToFile(recvFd, sendFd, fileFd),
    };
}

/**
 * Create an input redirect that converts bytes to messages.
 *
 * Reads bytes from the file and sends them as Response messages
 * to the process via a message pipe.
 * Call start() AFTER spawning the process to begin pumping bytes to messages.
 *
 * @param path - Path to the input file
 * @returns Handle with fd for process stdin and start() to begin pump
 *
 * @example
 * // cmd < /tmp/in
 * const redirect = await inputRedirect('/tmp/in');
 * await spawn('/bin/cmd', { stdin: redirect.fd });
 * await redirect.start();  // Start pump AFTER spawn
 */
export async function inputRedirect(path: string): Promise<RedirectHandle> {
    // Open the input file
    const fileFd = await open(path, { read: true });

    // Create a message pipe for the process's stdin
    const [recvFd, sendFd] = await pipe();

    // Return handle with start function that kicks off the pump
    return {
        fd: recvFd,
        start: () => pumpFileToMessages(fileFd, recvFd, sendFd),
    };
}

// =============================================================================
// Internal Pump Functions
// =============================================================================

/**
 * Pump messages from a pipe to a file, converting to bytes.
 *
 * Extracts text from 'item' messages and bytes from 'data' messages,
 * writing them to the file. Takes ownership of all fds and closes them.
 */
async function pumpMessagesToFile(
    pipeRecvFd: number,
    pipeSendFd: number,
    fileFd: number,
): Promise<void> {
    // Close the shell's copy of the write end. The spawned process has its own
    // copy. When the process exits, the pipe will signal EOF to the pump.
    await close(pipeSendFd).catch(() => {});

    try {
        const encoder = new TextEncoder();

        for await (const msg of recv(pipeRecvFd)) {
            // Extract text from message
            let text: string | undefined;

            if (msg.op === 'item' && msg.data && typeof msg.data === 'object') {
                const data = msg.data as { text?: string };

                text = data.text;
            }
            else if (msg.op === 'data' && msg.bytes) {
                // Binary data - write directly
                await write(fileFd, msg.bytes);
                continue;
            }

            if (text !== undefined) {
                await write(fileFd, encoder.encode(text));
            }
        }
    }
    finally {
        // Close our fds when pump completes
        await close(pipeRecvFd).catch(() => {});
        await close(fileFd).catch(() => {});
    }
}

/**
 * Pump bytes from a file to a pipe, converting to messages.
 *
 * Reads bytes from the file and sends them as 'data' Response messages.
 * Takes ownership of all fds and closes them.
 */
async function pumpFileToMessages(
    fileFd: number,
    pipeRecvFd: number,
    pipeSendFd: number,
): Promise<void> {
    // Close the shell's copy of the read end. The spawned process has its own
    // copy. This ensures the process sees EOF when the pump finishes.
    await close(pipeRecvFd).catch(() => {});

    try {
        for await (const chunk of read(fileFd)) {
            await send(pipeSendFd, respond.data(chunk));
        }

        // Signal end of input
        await send(pipeSendFd, respond.done());
    }
    finally {
        // Close our fds when pump completes
        await close(pipeSendFd).catch(() => {});
        await close(fileFd).catch(() => {});
    }
}
