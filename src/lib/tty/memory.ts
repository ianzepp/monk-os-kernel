/**
 * TTY Memory System
 *
 * Short-term memory (STM) and long-term memory (LTM) functions.
 * Separated from profile.ts to avoid circular dependencies with commands.
 */

import type { Session } from './types.js';
import { runTransaction } from '@src/lib/transaction.js';

// =============================================================================
// SHORT TERM MEMORY (STM)
// =============================================================================

const STM_FILE = '.config/stm.json';

export interface STMAlarm {
    id: string;
    message: string;
    due: string;  // ISO timestamp
    created: string;  // ISO timestamp
}

export interface STMDataFull {
    entries: Record<string, string>;
    alarms: STMAlarm[];
}

// Legacy type for backward compatibility
export type STMData = Record<string, string>;

/**
 * Load full STM data from ~/.config/stm.json
 */
export async function loadSTMFull(session: Session): Promise<STMDataFull> {
    if (!session.systemInit) return { entries: {}, alarms: [] };

    try {
        let result: STMDataFull = { entries: {}, alarms: [] };
        await runTransaction(session.systemInit, async (system) => {
            const stmPath = `/home/${session.username}/${STM_FILE}`;

            try {
                const content = await system.fs.read(stmPath);
                const parsed = JSON.parse(content.toString());

                // Handle both old format (flat key-value) and new format
                if (parsed.entries !== undefined) {
                    result = {
                        entries: parsed.entries || {},
                        alarms: parsed.alarms || [],
                    };
                } else {
                    // Old format: convert to new
                    result = { entries: parsed, alarms: [] };
                }
            } catch {
                // No STM file - that's fine
            }
        });
        return result;
    } catch {
        return { entries: {}, alarms: [] };
    }
}

/**
 * Load STM entries only (backward compatible)
 */
export async function loadSTM(session: Session): Promise<STMData> {
    const full = await loadSTMFull(session);
    return full.entries;
}

/**
 * Save full STM data to ~/.config/stm.json
 */
export async function saveSTMFull(session: Session, data: STMDataFull): Promise<void> {
    if (!session.systemInit) return;

    try {
        await runTransaction(session.systemInit, async (system) => {
            const configDir = `/home/${session.username}/.config`;
            const stmPath = `${configDir}/stm.json`;

            // Ensure .config directory exists
            if (!await system.fs.exists(configDir)) {
                await system.fs.mkdir(configDir);
            }

            const isEmpty = Object.keys(data.entries).length === 0 && data.alarms.length === 0;

            // Save (or delete if empty)
            if (isEmpty) {
                try {
                    await system.fs.unlink(stmPath);
                } catch {
                    // File might not exist
                }
            } else {
                await system.fs.write(stmPath, JSON.stringify(data, null, 2) + '\n');
            }
        });
    } catch {
        // Ignore save errors
    }
}

/**
 * Save STM entries (backward compatible, preserves alarms)
 */
export async function saveSTM(session: Session, entries: STMData): Promise<void> {
    const full = await loadSTMFull(session);
    full.entries = entries;
    await saveSTMFull(session, full);
}

/**
 * Get due and upcoming alarms formatted for AI prompt injection
 */
export function formatAlarmsForPrompt(alarms: STMAlarm[]): string | null {
    if (alarms.length === 0) return null;

    const now = Date.now();
    const lines: string[] = [];

    for (const alarm of alarms) {
        const due = new Date(alarm.due).getTime();
        const diff = due - now;

        let status: string;
        if (diff <= 0) {
            const overdue = Math.abs(diff);
            if (overdue < 60000) {
                status = 'due now';
            } else {
                status = `overdue by ${formatDuration(overdue)}`;
            }
        } else {
            status = `in ${formatDuration(diff)}`;
        }

        lines.push(`- [${status}] ${alarm.id.slice(0, 6)}: ${alarm.message}`);
    }

    return lines.join('\n');
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    } else if (minutes > 0) {
        return `${minutes}m`;
    } else {
        return `${seconds}s`;
    }
}

// =============================================================================
// AUTO-COALESCE
// =============================================================================

const COALESCE_SYSTEM_PROMPT = `You are reviewing a user's short-term memory (working context) to identify what should be preserved as long-term memories.

Analyze the provided working context and identify 0-5 facts, insights, or learnings that are worth preserving permanently. These should be:
- Durable truths (not ephemeral state like "currently working on X")
- User preferences or patterns
- Important decisions or conclusions
- Learned behaviors or insights about the codebase/system

Respond with a JSON array of strings, each being a memory to save. If nothing is worth saving long-term, respond with an empty array.

Example responses:
["User prefers TypeScript over JavaScript", "The auth system uses JWT with 24h expiry"]
[]

Respond ONLY with the JSON array, no other text.`;

/**
 * Auto-coalesce STM on logout (if entries exist and API key available)
 *
 * @param session - The session to coalesce
 * @param write - Optional function to write status messages (null for silent)
 */
export async function autoCoalesce(
    session: Session,
    write?: (msg: string) => void
): Promise<void> {
    // Check API key before doing any work
    if (!process.env.ANTHROPIC_API_KEY) return;
    if (!session.systemInit) return;

    const stmData = await loadSTMFull(session);
    const entries = Object.entries(stmData.entries);

    // Skip if no entries (only alarms, or empty)
    if (entries.length === 0) return;

    write?.('Consolidating memories...\n');

    try {
        const stmContent = entries.map(([k, v]) => `${k}: ${v}`).join('\n');
        const prompt = `Short-term memory contents:\n${stmContent}`;

        // Use system.ai for the AI call
        let aiResponse: string;
        await runTransaction(session.systemInit, async (system) => {
            aiResponse = await system.ai.prompt(prompt, {
                systemPrompt: COALESCE_SYSTEM_PROMPT,
                maxTokens: 1024,
            });
        });

        let memories: string[];
        try {
            memories = JSON.parse(aiResponse!.trim());
            if (!Array.isArray(memories)) return;
        } catch {
            return;
        }

        if (memories.length === 0) {
            // Nothing worth saving, just clear entries
            stmData.entries = {};
            await saveSTMFull(session, stmData);
            return;
        }

        // Save to LTM
        // Import dynamically to avoid circular dependencies
        const { getHonoApp } = await import('@src/lib/internal-api.js');
        const { JWTGenerator } = await import('@src/lib/jwt-generator.js');

        const app = getHonoApp();
        if (!app) return;

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

            if (ltmResponse.ok) savedCount++;
        }

        if (savedCount > 0) {
            write?.(`Saved ${savedCount} memor${savedCount === 1 ? 'y' : 'ies'} to LTM.\n`);
        }

        // Clear STM entries (preserve alarms)
        stmData.entries = {};
        await saveSTMFull(session, stmData);
    } catch {
        // Fail silently - don't block logout
    }
}
