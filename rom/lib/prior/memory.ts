/**
 * Prior Memory - Memory consolidation for the Prior AI process
 *
 * PURPOSE
 * =======
 * Implements memory consolidation: the process of reviewing short-term
 * memories (STM) and extracting lasting insights into long-term memory
 * (LTM). This mimics biological memory consolidation during sleep.
 *
 * CONSOLIDATION PROCESS
 * =====================
 * 1. Find unconsolidated STM entries ordered by salience
 * 2. Send to LLM for insight extraction
 * 3. Store insights in LTM with category tags
 * 4. Mark STM entries as consolidated
 *
 * CATEGORIES
 * ==========
 * - user_prefs: User preferences and settings
 * - project_facts: Facts about projects
 * - lessons: Lessons learned
 * - patterns: Recurring patterns
 * - corrections: Things to remember not to do
 *
 * @module rom/lib/prior/memory
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { call } from '@rom/lib/process/index.js';

import type { StmEntry, Instruction } from './types.js';
import { log } from './logging.js';
import { executeTask } from './task.js';

// =============================================================================
// MEMORY CONSOLIDATION
// =============================================================================

/**
 * Consolidate short-term memories into long-term storage.
 *
 * Runs periodically during idle ticks (every ~10 minutes).
 * Reviews STM entries by salience and extracts insights.
 */
export async function consolidateMemory(): Promise<void> {
    await log('prior: starting memory consolidation');

    try {
        // Find unconsolidated STM entries, ordered by salience
        const stmEntries = await call<StmEntry[]>(
            'ems:select',
            'ai.stm',
            {
                where: { consolidated: 0 },
                orderBy: ['-salience', 'created_at'],
                limit: 20,
            },
        );

        if (stmEntries.length === 0) {
            await log('prior: no memories to consolidate');

            return;
        }

        await log(`prior: consolidating ${stmEntries.length} memories`);

        // Build context for LLM
        const memoryList = stmEntries
            .map((m, i) => `[${i + 1}] (salience=${m.salience}) ${m.content}`)
            .join('\n');

        const instruction: Instruction = {
            task: `Review these recent memories and extract lasting insights worth remembering long-term. For each insight, output a JSON object on its own line with format: {"content": "...", "category": "..."}

Categories: user_prefs, project_facts, lessons, patterns, corrections

Memories to review:
${memoryList}

Output only JSON lines, no commentary. If nothing is worth keeping, output nothing.`,
        };

        // WHY recursive: consolidateMemory is passed to executeTask to avoid circular deps
        // Use a stub that does nothing for the consolidation task itself
        const stubConsolidate = async (): Promise<void> => {};
        const result = await executeTask(instruction, { skipLogging: true }, stubConsolidate);

        if (result.status === 'ok' && result.result) {
            // Parse JSON lines from response
            const lines = result.result.split('\n').filter((l: string) => l.trim().startsWith('{'));

            for (const line of lines) {
                try {
                    const insight = JSON.parse(line) as { content: string; category: string };

                    // Create LTM entry
                    await call('ems:create', 'ai.ltm', {
                        content: insight.content,
                        category: insight.category,
                        source_ids: JSON.stringify(stmEntries.map(e => e.id)),
                        last_accessed: new Date().toISOString(),
                    });

                    await log(`prior: stored insight [${insight.category}]: ${insight.content.slice(0, 50)}...`);
                }
                catch {
                    // Skip malformed lines
                }
            }
        }

        // Mark all processed STM entries as consolidated
        const now = new Date().toISOString();

        for (const entry of stmEntries) {
            await call('ems:update', 'ai.stm', entry.id, {
                consolidated: 1,
                consolidated_at: now,
            });
        }

        await log('prior: memory consolidation complete');
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await log(`prior: consolidation error: ${message}`);
    }
}
