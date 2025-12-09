/**
 * Prior HTTP - HTTP connection handling for the Prior AI process
 *
 * PURPOSE
 * =======
 * Handles HTTP connections to the Prior TCP server. Wraps raw sockets
 * in an HTTP channel, parses requests, executes tasks, and sends responses.
 *
 * PROTOCOL
 * ========
 * - POST / with JSON body: { task: string, context?: object, model?: string }
 * - Response: { status, result?, error?, model?, duration_ms?, request_id? }
 *
 * @module rom/lib/prior/http
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { call } from '@rom/lib/process/index.js';

import type { Instruction, HttpRequest } from './types.js';
import { log } from './logging.js';
import { executeTask } from './task.js';
import { consolidateMemory } from './memory.js';

// =============================================================================
// HTTP CONNECTION HANDLING
// =============================================================================

/**
 * Handle a single client connection using HTTP channel.
 *
 * @param socketFd - The raw socket file descriptor
 * @param from - Client address string
 */
export async function handleConnection(socketFd: number, from: string): Promise<void> {
    let channelFd: number | undefined;

    try {
        // Wrap socket in HTTP server channel
        channelFd = await call<number>('channel:accept', socketFd, 'http');

        // Receive HTTP request (parsed by channel)
        const recvResult = await call<{ op: string; data: HttpRequest }>('channel:recv', channelFd);
        const request = recvResult.data;

        await log(`prior: ${request.method} ${request.path} from ${from}`);

        // Only accept POST to root
        if (request.method !== 'POST' || (request.path !== '/' && request.path !== '')) {
            await call<void>('channel:push', channelFd, {
                op: 'ok',
                data: {
                    status: 405,
                    body: { error: 'Method not allowed', message: 'Use POST /' },
                },
            });
            return;
        }

        // Parse instruction from body
        const body = request.body as Record<string, unknown> | null;

        if (!body || typeof body.task !== 'string') {
            await call<void>('channel:push', channelFd, {
                op: 'ok',
                data: {
                    status: 400,
                    body: { error: 'Bad request', message: 'Missing or invalid task field' },
                },
            });
            return;
        }

        const instruction: Instruction = {
            task: body.task,
            context: body.context as Record<string, unknown> | undefined,
            model: body.model as string | undefined,
        };

        await log(`prior: received task from ${from}: ${instruction.task.slice(0, 50)}...`);

        // Execute task
        await log(`prior: executing task...`);
        const result = await executeTask(instruction, { clientAddr: from }, consolidateMemory);
        await log(`prior: task complete, sending response...`);

        // Send HTTP response
        await call<void>('channel:push', channelFd, {
            op: 'ok',
            data: {
                status: 200,
                body: result,
            },
        });

        await log(`prior: completed task in ${result.duration_ms}ms`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await log(`prior: connection error: ${message}`);

        // Try to send error response
        if (channelFd !== undefined) {
            try {
                await call<void>('channel:push', channelFd, {
                    op: 'ok',
                    data: {
                        status: 500,
                        body: { error: 'Internal error', message },
                    },
                });
            }
            catch {
                // Ignore write errors during error handling
            }
        }
    }
    finally {
        // Close channel (this also closes the underlying socket)
        if (channelFd !== undefined) {
            try {
                await call<void>('channel:close', channelFd);
            }
            catch {
                // Ignore close errors
            }
        }
    }
}
