/**
 * LLM Syscalls - Language Model inference operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * LLM syscalls provide the interface between user processes and the LLM
 * subsystem. Each syscall is a standalone async generator function that
 * receives explicit dependencies (proc, llm) and yields Response messages.
 *
 * Operations:
 * - llm:complete  - Single-shot completion (non-streaming)
 * - llm:stream    - Streaming completion
 * - llm:chat      - Chat completion (non-streaming)
 * - llm:embed     - Generate embeddings
 * - llm:models    - List available models
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Model argument must be a non-empty string
 * INV-2: Every syscall must yield at least one Response (ok, error, item, done)
 * INV-3: Stream responses terminate with 'done'
 * INV-4: Single-value responses use 'ok'
 *
 * @module syscall/llm
 */

import type { LLM } from '@src/llm/index.js';
import type { WhereConditions } from '@src/ems/index.js';
import type { Process, Response } from './types.js';
import { respond } from './types.js';

// =============================================================================
// COMPLETION OPERATIONS
// =============================================================================

/**
 * Generate a completion (non-streaming).
 *
 * @param proc - Calling process
 * @param llm - LLM subsystem
 * @param model - Model name
 * @param prompt - Prompt text
 * @param options - Optional parameters (system, temperature, max_tokens, stop)
 */
export async function* llmComplete(
    _proc: Process,
    llm: LLM,
    model: unknown,
    prompt: unknown,
    options?: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string' || model.length === 0) {
        yield respond.error('EINVAL', 'model must be a non-empty string');

        return;
    }

    if (typeof prompt !== 'string') {
        yield respond.error('EINVAL', 'prompt must be a string');

        return;
    }

    const opts = (typeof options === 'object' && options !== null)
        ? options as Record<string, unknown>
        : {};

    try {
        const response = await llm.complete({
            model,
            prompt,
            system: typeof opts.system === 'string' ? opts.system : undefined,
            temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined,
            max_tokens: typeof opts.max_tokens === 'number' ? opts.max_tokens : undefined,
            stop: Array.isArray(opts.stop) ? opts.stop as string[] : undefined,
        });

        yield respond.ok(response);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Generate a streaming completion.
 *
 * Yields chunks as 'item' responses, followed by 'done'.
 *
 * @param proc - Calling process
 * @param llm - LLM subsystem
 * @param model - Model name
 * @param prompt - Prompt text
 * @param options - Optional parameters (system, temperature, max_tokens, stop)
 */
export async function* llmStream(
    _proc: Process,
    llm: LLM,
    model: unknown,
    prompt: unknown,
    options?: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string' || model.length === 0) {
        yield respond.error('EINVAL', 'model must be a non-empty string');

        return;
    }

    if (typeof prompt !== 'string') {
        yield respond.error('EINVAL', 'prompt must be a string');

        return;
    }

    const opts = (typeof options === 'object' && options !== null)
        ? options as Record<string, unknown>
        : {};

    try {
        for await (const chunk of llm.completeStream({
            model,
            prompt,
            system: typeof opts.system === 'string' ? opts.system : undefined,
            temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined,
            max_tokens: typeof opts.max_tokens === 'number' ? opts.max_tokens : undefined,
            stop: Array.isArray(opts.stop) ? opts.stop as string[] : undefined,
        })) {
            yield respond.item(chunk);
        }

        yield respond.done();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

// =============================================================================
// CHAT OPERATIONS
// =============================================================================

/**
 * Chat completion (non-streaming).
 *
 * @param proc - Calling process
 * @param llm - LLM subsystem
 * @param model - Model name
 * @param messages - Chat messages array
 * @param options - Optional parameters (temperature, max_tokens, stop)
 */
export async function* llmChat(
    _proc: Process,
    llm: LLM,
    model: unknown,
    messages: unknown,
    options?: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string' || model.length === 0) {
        yield respond.error('EINVAL', 'model must be a non-empty string');

        return;
    }

    if (!Array.isArray(messages)) {
        yield respond.error('EINVAL', 'messages must be an array');

        return;
    }

    // Validate message structure
    for (const msg of messages) {
        if (typeof msg !== 'object' || msg === null) {
            yield respond.error('EINVAL', 'each message must be an object');

            return;
        }

        const m = msg as Record<string, unknown>;

        if (typeof m.role !== 'string' || typeof m.content !== 'string') {
            yield respond.error('EINVAL', 'each message must have role and content strings');

            return;
        }
    }

    const opts = (typeof options === 'object' && options !== null)
        ? options as Record<string, unknown>
        : {};

    try {
        const response = await llm.chat({
            model,
            messages: messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
            temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined,
            max_tokens: typeof opts.max_tokens === 'number' ? opts.max_tokens : undefined,
            stop: Array.isArray(opts.stop) ? opts.stop as string[] : undefined,
        });

        yield respond.ok(response);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Streaming chat completion.
 *
 * Yields chunks as 'item' responses, followed by 'done'.
 *
 * @param proc - Calling process
 * @param llm - LLM subsystem
 * @param model - Model name
 * @param messages - Chat messages array
 * @param options - Optional parameters (temperature, max_tokens, stop)
 */
export async function* llmChatStream(
    _proc: Process,
    llm: LLM,
    model: unknown,
    messages: unknown,
    options?: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string' || model.length === 0) {
        yield respond.error('EINVAL', 'model must be a non-empty string');

        return;
    }

    if (!Array.isArray(messages)) {
        yield respond.error('EINVAL', 'messages must be an array');

        return;
    }

    // Validate message structure
    for (const msg of messages) {
        if (typeof msg !== 'object' || msg === null) {
            yield respond.error('EINVAL', 'each message must be an object');

            return;
        }

        const m = msg as Record<string, unknown>;

        if (typeof m.role !== 'string' || typeof m.content !== 'string') {
            yield respond.error('EINVAL', 'each message must have role and content strings');

            return;
        }
    }

    const opts = (typeof options === 'object' && options !== null)
        ? options as Record<string, unknown>
        : {};

    try {
        for await (const chunk of llm.chatStream({
            model,
            messages: messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
            temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined,
            max_tokens: typeof opts.max_tokens === 'number' ? opts.max_tokens : undefined,
            stop: Array.isArray(opts.stop) ? opts.stop as string[] : undefined,
        })) {
            yield respond.item(chunk);
        }

        yield respond.done();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

// =============================================================================
// EMBEDDING OPERATIONS
// =============================================================================

/**
 * Generate embeddings.
 *
 * @param proc - Calling process
 * @param llm - LLM subsystem
 * @param model - Model name (must support embeddings)
 * @param input - Text to embed (string or array of strings)
 */
export async function* llmEmbed(
    _proc: Process,
    llm: LLM,
    model: unknown,
    input: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string' || model.length === 0) {
        yield respond.error('EINVAL', 'model must be a non-empty string');

        return;
    }

    if (typeof input !== 'string' && !Array.isArray(input)) {
        yield respond.error('EINVAL', 'input must be a string or array of strings');

        return;
    }

    if (Array.isArray(input) && !input.every(i => typeof i === 'string')) {
        yield respond.error('EINVAL', 'all inputs must be strings');

        return;
    }

    try {
        const response = await llm.embed({
            model,
            input: input as string | string[],
        });

        yield respond.ok(response);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

// =============================================================================
// MODEL LISTING
// =============================================================================

/**
 * List available models.
 *
 * Streams models as 'item' responses, followed by 'done'.
 *
 * @param proc - Calling process
 * @param llm - LLM subsystem
 * @param filter - Optional filter (e.g., { supports_embeddings: 1 })
 */
export async function* llmModels(
    _proc: Process,
    llm: LLM,
    filter?: unknown,
): AsyncIterable<Response> {
    const filterData = (typeof filter === 'object' && filter !== null)
        ? filter as WhereConditions
        : undefined;

    try {
        for await (const model of llm.listModels(filterData)) {
            yield respond.item(model);
        }

        yield respond.done();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}
