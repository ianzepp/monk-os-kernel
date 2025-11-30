/**
 * coalesce - Consolidate short-term memory into long-term memory
 *
 * Like the human sleep cycle: reviews STM, saves important insights to LTM,
 * then clears STM for a fresh start.
 *
 * Usage:
 *   coalesce              Run AI-assisted memory consolidation
 *   coalesce --dry-run    Show what would be saved without committing
 */

import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';
import { loadSTM, saveSTM } from '../memory.js';
import { getHonoApp } from '@src/lib/internal-api.js';
import { JWTGenerator } from '@src/lib/jwt-generator.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const COALESCE_PROMPT = `You are reviewing a user's short-term memory (working context) to identify what should be preserved as long-term memories.

Short-term memory contents:
{STM_CONTENT}

Analyze this working context and identify 0-5 facts, insights, or learnings that are worth preserving permanently. These should be:
- Durable truths (not ephemeral state like "currently working on X")
- User preferences or patterns
- Important decisions or conclusions
- Learned behaviors or insights about the codebase/system

Respond with a JSON array of strings, each being a memory to save. If nothing is worth saving long-term, respond with an empty array.

Example responses:
["User prefers TypeScript over JavaScript", "The auth system uses JWT with 24h expiry"]
[]

Respond ONLY with the JSON array, no other text.`;

export const coalesce: CommandHandler = async (session, _fs, args, io) => {
    const { flags } = parseArgs(args, {
        dryRun: { long: 'dry-run', short: 'n', desc: 'Show what would be saved' },
    });

    const dryRun = flags.dryRun === true;

    // Check for API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        io.stderr.write('coalesce: ANTHROPIC_API_KEY not configured\n');
        return 1;
    }

    // Load current STM
    const stm = await loadSTM(session);
    const entries = Object.entries(stm);

    if (entries.length === 0) {
        io.stdout.write('Nothing to coalesce (STM is empty)\n');
        return 0;
    }

    // Format STM for the AI
    const stmContent = entries.map(([k, v]) => `${k}: ${v}`).join('\n');
    const prompt = COALESCE_PROMPT.replace('{STM_CONTENT}', stmContent);

    io.stdout.write('Analyzing short-term memory...\n');

    try {
        // Call Claude API
        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            io.stderr.write(`coalesce: API error ${response.status}: ${error}\n`);
            return 1;
        }

        const result = await response.json() as {
            content: { type: string; text: string }[];
        };

        // Extract the text response
        const textBlock = result.content.find(b => b.type === 'text');
        if (!textBlock) {
            io.stderr.write('coalesce: No response from AI\n');
            return 1;
        }

        // Parse the JSON array
        let memories: string[];
        try {
            memories = JSON.parse(textBlock.text.trim());
            if (!Array.isArray(memories)) {
                throw new Error('Not an array');
            }
        } catch {
            io.stderr.write(`coalesce: Invalid AI response: ${textBlock.text}\n`);
            return 1;
        }

        if (memories.length === 0) {
            io.stdout.write('No memories worth preserving long-term.\n');
            if (!dryRun) {
                await saveSTM(session, {});
                io.stdout.write('STM cleared.\n');
            }
            return 0;
        }

        // Show what will be saved
        io.stdout.write(`\nMemories to save (${memories.length}):\n`);
        for (const mem of memories) {
            io.stdout.write(`  - ${mem}\n`);
        }
        io.stdout.write('\n');

        if (dryRun) {
            io.stdout.write('(dry run - no changes made)\n');
            return 0;
        }

        // Save to LTM
        if (!session.systemInit) {
            io.stderr.write('coalesce: database not available\n');
            return 1;
        }

        const app = getHonoApp();
        if (!app) {
            io.stderr.write('coalesce: internal API not available\n');
            return 1;
        }

        const token = await JWTGenerator.fromSystemInit(session.systemInit);

        let savedCount = 0;
        for (const content of memories) {
            const ltmResponse = await app.fetch(new Request('http://localhost/api/data/memories', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    owner: session.username,
                    content,
                }),
            }));

            if (ltmResponse.ok) {
                savedCount++;
            } else {
                const error = await ltmResponse.text();
                io.stderr.write(`coalesce: failed to save memory: ${error}\n`);
            }
        }

        io.stdout.write(`Saved ${savedCount} memories to LTM.\n`);

        // Clear STM
        await saveSTM(session, {});
        io.stdout.write('STM cleared.\n');

        return 0;
    } catch (err) {
        io.stderr.write(`coalesce: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
};
