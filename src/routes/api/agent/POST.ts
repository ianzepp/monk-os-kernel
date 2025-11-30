/**
 * POST /api/agent - Execute AI agent with a prompt
 *
 * Content negotiation via Accept header:
 * - Accept: application/json (default) - Returns single JSON response
 * - Accept: text/jsonl - Streams JSONL events as they occur
 *
 * Request body:
 * {
 *   "prompt": "what records changed in the last day"
 * }
 *
 * JSON Response:
 * {
 *   "success": true,
 *   "data": {
 *     "success": true,
 *     "response": "...",
 *     "toolCalls": [...]
 *   }
 * }
 *
 * JSONL Response (streamed):
 * {"type":"tool_call","name":"run_command","input":{"command":"..."}}
 * {"type":"tool_result","name":"run_command","output":"..."}
 * {"type":"text","content":"Based on the results..."}
 * {"type":"done","success":true}
 */

import type { Context } from 'hono';
import type { SystemInit } from '@src/lib/system.js';
import { executeAgentPrompt, executeAgentPromptStream } from '@src/lib/tty/headless.js';
import { createSuccessResponse, createValidationError } from '@src/lib/api-helpers.js';

export default async function AgentPost(context: Context) {
    // systemInit is set by authValidatorMiddleware for /api/* routes
    const systemInit = context.get('systemInit') as SystemInit;

    const body = context.get('parsedBody') as { prompt?: string; maxTurns?: number } | undefined;

    if (!body?.prompt || typeof body.prompt !== 'string') {
        return createValidationError(context, 'Request body must include "prompt" string', [
            { field: 'prompt', message: 'Required string field' }
        ]);
    }

    // Capture validated values for closure
    const prompt = body.prompt;
    const maxTurns = body.maxTurns;

    // Check Accept header for content negotiation
    const accept = context.req.header('Accept') || 'application/json';
    const wantsStream = accept.includes('text/jsonl');

    if (wantsStream) {
        // Streaming JSONL response
        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();

                try {
                    for await (const event of executeAgentPromptStream(systemInit, prompt, {
                        maxTurns,
                    })) {
                        const line = JSON.stringify(event) + '\n';
                        controller.enqueue(encoder.encode(line));
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const errorEvent = JSON.stringify({ type: 'error', message }) + '\n';
                    controller.enqueue(encoder.encode(errorEvent));
                    const doneEvent = JSON.stringify({ type: 'done', success: false }) + '\n';
                    controller.enqueue(encoder.encode(doneEvent));
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/jsonl; charset=utf-8',
                'Transfer-Encoding': 'chunked',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });
    }

    // Standard JSON response
    const result = await executeAgentPrompt(systemInit, prompt, {
        maxTurns,
    });

    return createSuccessResponse(context, result);
}
