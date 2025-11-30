/**
 * @ (ai) - Send a prompt to the LLM
 *
 * Usage:
 *   @ <prompt>                    Ask a question (one-shot)
 *   @                             Enter conversation mode
 *   <input> | @ <prompt>          Ask about piped data
 *   <input> | @                   Analyze piped data (default prompt)
 *
 * Examples:
 *   @ what time is it in Tokyo?
 *   cat /api/data/users | @ summarize this data
 *   select * from users | @ find users with admin role
 *   @ list 10 common unix commands | head -5
 *   @                              (enters conversation mode)
 *
 * Conversation Mode:
 *   In conversation mode, the AI can execute commands on your behalf.
 *   Type 'exit' or press Ctrl+D to return to the shell.
 *
 * Environment:
 *   ANTHROPIC_API_KEY    Required. Your Anthropic API key.
 *
 * The LLM receives context about your current session including
 * working directory and any piped input data.
 */

import type { CommandHandler } from '../shared.js';
import { oneShotMode, conversationMode } from './modes.js';
import { PassThrough } from 'node:stream';

/**
 * Check if a stream has data available (with timeout)
 */
async function hasData(stream: PassThrough, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        // Check if stream already has buffered data
        if (stream.readableLength > 0) {
            resolve(true);
            return;
        }

        // Check if stream is already ended
        if (stream.readableEnded) {
            resolve(false);
            return;
        }

        const timeout = setTimeout(() => {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            resolve(false);
        }, timeoutMs);

        const onData = () => {
            clearTimeout(timeout);
            stream.removeListener('end', onEnd);
            // Unshift the data back - we just peeked
            resolve(true);
        };

        const onEnd = () => {
            clearTimeout(timeout);
            stream.removeListener('data', onData);
            resolve(false);
        };

        stream.once('readable', onData);
        stream.once('end', onEnd);
    });
}

export const ai: CommandHandler = async (session, fs, args, io) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        io.stderr.write('ai: ANTHROPIC_API_KEY environment variable not set\n');
        return 1;
    }

    // Check if we have piped input (non-interactive)
    const hasStdinData = await hasData(io.stdin, 50);

    // Build prompt from args
    const prompt = args.join(' ').trim();

    // Read stdin if there's data
    let stdinContent = '';
    if (hasStdinData) {
        const chunks: string[] = [];
        for await (const chunk of io.stdin) {
            if (io.signal?.aborted) return 130;
            chunks.push(chunk.toString());
        }
        stdinContent = chunks.join('');
    }

    // Conversation mode: no args and no piped input
    if (!prompt && !stdinContent) {
        return conversationMode(session, fs, apiKey, io);
    }

    // One-shot mode
    return oneShotMode(session, apiKey, prompt, stdinContent, io);
};
