/**
 * gatewayd Smoke Tests
 *
 * Tests the Unix socket gateway daemon that bridges external apps to kernel syscalls.
 * These tests boot a full OS instance, start gatewayd, and communicate via Unix socket.
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { OS } from '@src/index.js';

// =============================================================================
// TEST CONFIGURATION
// =============================================================================

/**
 * Generate a unique socket path per test run.
 * WHY: Prevents conflicts between parallel test runs or lingering sockets.
 */
function uniqueSocketPath(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);

    return `/tmp/monk-test-${timestamp}-${random}.sock`;
}

/**
 * Wire protocol helpers.
 */
function encodeSyscall(id: string, name: string, args: unknown[]): string {
    return JSON.stringify({ type: 'syscall', id, name, args }) + '\n';
}

interface WireResponse {
    type: 'response';
    id: string;
    result?: {
        op: 'ok' | 'error' | 'item' | 'data' | 'done';
        data?: unknown;
        code?: string;
        message?: string;
    };
    error?: {
        code: string;
        message: string;
    };
}

function decodeResponse(line: string): WireResponse {
    return JSON.parse(line) as WireResponse;
}

/**
 * Wait for socket to become available using fs.stat.
 * WHY: gatewayd needs time to start and bind the socket after service('start').
 */
async function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
    const { stat } = await import('node:fs/promises');
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeoutMs) {
        try {
            const info = await stat(socketPath);

            // Check if it's a socket
            if (info.isSocket()) {
                return;
            }
        }
        catch {
            // Socket not ready yet, keep polling
        }

        await Bun.sleep(pollInterval);
    }

    throw new Error(`Socket ${socketPath} not available after ${timeoutMs}ms`);
}

/**
 * Connect to gatewayd and exchange a syscall.
 * Returns all response lines received.
 */
async function sendSyscall(
    socketPath: string,
    id: string,
    name: string,
    args: unknown[],
    timeoutMs = 5000,
): Promise<WireResponse[]> {
    const responses: WireResponse[] = [];
    let buffer = '';
    let resolved = false;

    return new Promise((resolve, reject) => {
        // Set timeout to prevent hanging
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                reject(new Error(`Syscall timeout after ${timeoutMs}ms. Buffer: ${buffer}, Responses: ${responses.length}`));
            }
        }, timeoutMs);

        const doResolve = (result: WireResponse[]) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(result);
            }
        };

        const doReject = (err: Error) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(err);
            }
        };

        try {
            Bun.connect({
                unix: socketPath,
                socket: {
                    data(socket, data) {
                        buffer += new TextDecoder().decode(data);

                        // Process complete lines
                        let newlineIdx: number;

                        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.slice(0, newlineIdx);

                            buffer = buffer.slice(newlineIdx + 1);

                            if (line.trim()) {
                                try {
                                    const response = decodeResponse(line);

                                    responses.push(response);

                                    // Check for terminal response
                                    if (response.result?.op === 'ok' ||
                                        response.result?.op === 'error' ||
                                        response.result?.op === 'done' ||
                                        response.error) {
                                        socket.end();
                                        doResolve(responses);

                                        return;
                                    }
                                }
                                catch (err) {
                                    doReject(new Error(`Failed to parse response: ${line}`));

                                    return;
                                }
                            }
                        }
                    },
                    open(socket) {
                        // Send syscall request
                        const request = encodeSyscall(id, name, args);

                        socket.write(request);
                    },
                    close() {
                        // Connection closed - resolve with whatever we have
                        doResolve(responses);
                    },
                    error(socket, error) {
                        doReject(error);
                    },
                },
            });
        }
        catch (err) {
            doReject(err as Error);
        }
    });
}

// =============================================================================
// TESTS
// =============================================================================

describe('gatewayd', () => {
    let os: OS | null = null;
    let socketPath: string;

    beforeEach(() => {
        socketPath = uniqueSocketPath();
    });

    afterEach(async () => {
        if (os?.isBooted()) {
            // Stop gatewayd first - its accept loop blocks shutdown
            try {
                await os.service('stop', 'gatewayd');
            }
            catch {
                // Ignore if service not running
            }

            await os.shutdown();
        }

        os = null;

        // Clean up socket file (gatewayd unlinks on start, but cleanup just in case)
        try {
            const { unlink } = await import('node:fs/promises');

            await unlink(socketPath);
        }
        catch {
            // Ignore if file doesn't exist
        }
    });

    describe('smoke tests', () => {
        it('should accept connection and respond to proc:getpid', async () => {
            // Boot OS with MONK_SOCKET env var that will propagate to gatewayd
            os = new OS({
                storage: { type: 'memory' },
                env: {
                    HOME: '/',
                    USER: 'root',
                    MONK_SOCKET: socketPath,
                },
            });

            await os.boot();

            // Start gatewayd service
            await os.service('start', 'gatewayd');

            // Wait for socket to be ready
            await waitForSocket(socketPath);

            // Send a simple syscall
            const requestId = 'test-001';
            const responses = await sendSyscall(socketPath, requestId, 'proc:getpid', []);

            // Verify response
            expect(responses.length).toBeGreaterThan(0);

            const response = responses[0]!;

            expect(response.type).toBe('response');
            expect(response.id).toBe(requestId);
            expect(response.result).toBeDefined();
            expect(response.result!.op).toBe('ok');

            // proc:getpid returns a PID (number)
            expect(typeof response.result!.data).toBe('number');
            expect(response.result!.data).toBeGreaterThan(0);
        }, 30000);  // 30s timeout for OS boot + gatewayd + syscall + shutdown
    });
});
